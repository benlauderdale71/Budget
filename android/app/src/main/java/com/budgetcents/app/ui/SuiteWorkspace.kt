package com.budgetcents.app.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.webkit.*
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.budgetcents.app.MainActivity
import com.budgetcents.app.Store
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

private fun Uri.sameOrigin(origin: Uri) = scheme == origin.scheme && host.equals(origin.host, true) && effectivePort() == origin.effectivePort()
private fun Uri.effectivePort() = if (port >= 0) port else if (scheme == "https") 443 else 80
private fun Uri.isMarket() = path == "/stocks-crypto" || path.orEmpty().startsWith("/stocks-crypto/")
private fun external(activity: Activity, uri: Uri) {
    if (uri.scheme !in setOf("https", "http", "mailto", "tel")) return
    runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, uri)) }.onFailure {
        Toast.makeText(activity, "No app is available to open this link.", Toast.LENGTH_LONG).show()
    }
}

private class PackagedSuite(private val context: Context, val origin: Uri) {
    private val catalog = DeviceCatalog(context)
    private val staticFiles = context.assets.list("suite").orEmpty().toSet() +
        context.assets.list("suite/assets").orEmpty().map { "assets/$it" }
    private val shell = context.assets.open("suite/index.html").bufferedReader().use { it.readText() }
        .replace("<html lang=\"en\">", "<html lang=\"en\" data-budget-device=\"1\">").toByteArray()
    private val headers = mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff",
        "Content-Security-Policy" to "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")

    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val uri=request.url
        val path=uri.path.orEmpty()
        if (!uri.sameOrigin(origin)) return deviceResponse("text/plain",403,byteArrayOf())
        if (request.isForMainFrame) {
            if (request.method!="GET" || path.startsWith("/api/") || path.startsWith("/_device/") || uri.isMarket())
                return deviceResponse("text/plain",403,byteArrayOf())
            return deviceResponse("text/html",200,shell,headers)
        }
        if (path.startsWith("/api/")) return null
        if (request.method!="GET") return deviceResponse("text/plain",403,byteArrayOf())
        if (path=="/_device/catalog") return catalog.lookup(uri)
        val name=path.removePrefix("/")
        if (name !in staticFiles || name=="index.html" || name=="assets") return deviceResponse("text/plain",404,byteArrayOf())
        val mime=when(name.substringAfterLast('.')) {
            "js"->"application/javascript"; "css"->"text/css"; "png"->"image/png"; "svg"->"image/svg+xml"
            "json"->"application/json"; "ico"->"image/x-icon"; "webmanifest"->"application/manifest+json"; else->"application/octet-stream"
        }
        return WebResourceResponse(mime, if(mime in setOf("application/javascript","text/css")) "UTF-8" else null,context.assets.open("suite/$name"))
    }
}

private data class Export(val name:String, val mime:String, val path:String?=null, val text:String?=null)
internal fun copyApiFile(store: Store, path: String, destination: File, owner: String) {
    check(store.userId == owner)
    val target=Uri.parse(path)
    require(!target.isAbsolute && target.authority==null && target.path.orEmpty().startsWith("/api/") && ".." !in target.pathSegments)
    val conn=URL(store.baseUrl+path).openConnection() as HttpURLConnection
    try {
        conn.instanceFollowRedirects=false; conn.connectTimeout=12000; conn.readTimeout=90000
        conn.setRequestProperty("Authorization","Bearer "+requireNotNull(store.token))
        require(conn.responseCode in 200..299)
        conn.inputStream.use { input->destination.outputStream().use { input.copyTo(it) } }
    } finally { conn.disconnect() }
    check(store.userId == owner)
}
private fun saveExport(context:Context, store:Store, source:Export, destination:Uri, owner:String) {
    check(store.userId==owner)
    val temporary=File.createTempFile("budget-export-", ".tmp",context.cacheDir)
    try {
        if (source.path!=null) {
            copyApiFile(store, source.path, temporary, owner)
        } else temporary.writeText(requireNotNull(source.text))
        check(store.userId==owner)
        requireNotNull(context.contentResolver.openOutputStream(destination,"wt")).use { out->temporary.inputStream().use { it.copyTo(out) } }
    } finally { temporary.delete() }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
internal fun SuiteWorkspace(activity:MainActivity, store:Store, initialPath:String, onTools:()->Unit, onSignedOut:()->Unit, onHousehold:(String)->Unit) {
    val origin=remember(store.baseUrl) { Uri.parse(store.baseUrl) }
    val owner=store.userId.orEmpty()
    val scope=rememberCoroutineScope()
    var issue by remember { mutableStateOf("") }
    var market by rememberSaveable { mutableStateOf<String?>(null) }
    var receiptPdf by remember { mutableStateOf<String?>(null) }
    var savedPath by rememberSaveable { mutableStateOf(initialPath) }
    var canBack by remember { mutableStateOf(false) }
    var marketBack by remember { mutableStateOf(false) }
    var refresh by remember { mutableIntStateOf(0) }
    val suite=remember { arrayOfNulls<WebView>(1) }
    val charts=remember { arrayOfNulls<WebView>(1) }
    val hostPort=remember { arrayOfNulls<WebMessagePort>(1) }
    val pendingFile=remember { arrayOfNulls<ValueCallback<Array<Uri>>>(1) }
    val pendingExport=remember { arrayOfNulls<Export>(1) }
    val signedOut by rememberUpdatedState(onSignedOut)
    val showTools by rememberUpdatedState(onTools)
    val chooseHouse by rememberUpdatedState(onHousehold)
    fun message(text:String) = Toast.makeText(activity,text,Toast.LENGTH_LONG).show()
    val pick=rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val files = if (result.resultCode == Activity.RESULT_OK) {
            result.data?.clipData?.let { clip -> Array(clip.itemCount) { clip.getItemAt(it).uri } }
                ?: WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        } else null
        pendingFile[0]?.onReceiveValue(files?.filter { it.scheme=="content" }?.toTypedArray());pendingFile[0]=null
    }
    val save=rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val export=pendingExport[0]; pendingExport[0]=null
        val target=result.data?.data
        if(export!=null && target?.scheme=="content" && result.resultCode==Activity.RESULT_OK) scope.launch {
            try { withContext(Dispatchers.IO) { saveExport(activity,store,export,target,owner) };message("File saved.") }
            catch (_:Exception) {message("The file could not be saved. Try the export again.")}
        }
    }
    fun export(data:JSONObject) {
        if(pendingExport[0]!=null)return
        val name=data.optString("name").substringAfterLast('/').substringAfterLast('\\').take(160).ifBlank{"budget-export"}
        val mime=when(name.substringAfterLast('.').lowercase()){"csv"->"text/csv";"json"->"application/json";"pdf"->"application/pdf";"png"->"image/png";"jpg","jpeg"->"image/jpeg";else->"application/octet-stream"}
        val item=if(data.optString("action")=="download") Export(name,mime,path=data.getString("path")) else Export(name,mime,text=data.getString("text").take(150000))
        pendingExport[0]=item
        runCatching { save.launch(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE,name)) }
            .onFailure { pendingExport[0]=null;message("No file picker is available.") }
    }
    fun configure(view:WebView) {
        view.settings.apply { javaScriptEnabled=true;domStorageEnabled=true;allowFileAccess=false;allowContentAccess=false
            mixedContentMode=WebSettings.MIXED_CONTENT_NEVER_ALLOW;setSupportMultipleWindows(false);javaScriptCanOpenWindowsAutomatically=false }
        CookieManager.getInstance().setAcceptThirdPartyCookies(view,false)
        view.webChromeClient=object:WebChromeClient() {
            override fun onShowFileChooser(v:WebView, callback:ValueCallback<Array<Uri>>, params:FileChooserParams):Boolean {
                pendingFile[0]?.onReceiveValue(null);pendingFile[0]=callback
                return try {pick.launch(params.createIntent());true} catch(_:Exception){pendingFile[0]=null;callback.onReceiveValue(null);true}
            }
        }
    }
    val supported=remember {
        val version=WebView.getCurrentWebViewPackage()?.versionName?.substringBefore('.')?.toIntOrNull()
        val valid=(origin.scheme=="https" || (origin.scheme=="http" && origin.host in setOf("localhost","127.0.0.1","10.0.2.2"))) && origin.userInfo==null && origin.path.orEmpty().trim('/').isEmpty()
        valid && (version==null || version>=107)
    }
    if (!supported) {
        Column(Modifier.safeDrawingPadding().padding(20.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            BudgetBrand();Text("Open the full suite in your browser or update Android System WebView to use it here.")
            Button(onClick={external(activity,origin)}){Text("Open Budget HQ Pro")};TextButton(onClick=onTools){Text("Device tools & offline dashboard")}
        }
        return
    }
    receiptPdf?.let { path -> ReceiptPdf(path, store, owner) { receiptPdf = null } }
    val content=remember(origin) { PackagedSuite(activity,origin) }
    DisposableEffect(Unit) { onDispose { pendingFile[0]?.onReceiveValue(null);pendingFile[0]=null;hostPort[0]?.close() } }
    BackHandler(enabled=market!=null || canBack) {
        if(market!=null) { if(marketBack)charts[0]?.goBack() else market=null }
        else suite[0]?.goBack()
    }
    Column(Modifier.fillMaxSize().safeDrawingPadding()) {
        if(issue.isNotEmpty()) {
            Text(issue,Modifier.padding(12.dp))
            Row { TextButton(onClick={issue="";refresh++}){Text("Retry")} ;TextButton(onClick=onTools){Text("Device tools")} }
        }
        Box(Modifier.fillMaxSize()) {
            key(refresh) {
                AndroidView(factory={ctx->WebView(ctx).apply {
                    suite[0]=this;configure(this)
                    webViewClient=object:WebViewClient() {
                        override fun shouldInterceptRequest(v:WebView,r:WebResourceRequest)=content.intercept(r)
                        override fun shouldOverrideUrlLoading(v:WebView,r:WebResourceRequest):Boolean {
                            if(!r.isForMainFrame)return false
                            if(!r.url.sameOrigin(origin)){external(activity,r.url);return true}
                            if(r.url.isMarket()){market=r.url.toString();return true}
                            return r.url.path.orEmpty().startsWith("/api/")
                        }
                        override fun onPageStarted(v:WebView,url:String,icon:Bitmap?) {hostPort[0]?.close();hostPort[0]=null}
                        override fun doUpdateVisitedHistory(v:WebView,url:String,reload:Boolean){canBack=v.canGoBack();val u=Uri.parse(url);if(u.sameOrigin(origin))savedPath=u.encodedPath.orEmpty()+(u.encodedQuery?.let{"?$it"}?:"")+(u.encodedFragment?.let{"#$it"}?:"")}
                        override fun onPageFinished(v:WebView,url:String) {
                            val u=Uri.parse(url)
                            if(!u.sameOrigin(origin) || u.isMarket() || u.path.orEmpty().startsWith("/api/") || store.userId!=owner || hostPort[0]!=null)return
                            val ports=v.createWebMessageChannel();hostPort[0]=ports[0]
                            ports[0].setWebMessageCallback(object:WebMessagePort.WebMessageCallback(){
                                override fun onMessage(port:WebMessagePort,event:WebMessage) {
                                    if(port!==hostPort[0] || store.userId!=owner)return
                                    val data=runCatching{JSONObject(event.data.orEmpty())}.getOrNull()?:return
                                    when(data.optString("action")){
                                        "signOut"->{CookieManager.getInstance().removeAllCookies(null);signedOut()}
                                        "household"->data.optString("id").takeIf{it.isNotBlank() && it!=store.householdId}?.let(chooseHouse)
                                        "deviceTools"->showTools()
                                        "markets"->{val dest=Uri.parse(origin.toString()+data.optString("path"));if(dest.sameOrigin(origin)&&dest.isMarket())market=dest.toString()}
                                        "receiptPdf" -> {
                                            val path = data.optString("path")
                                            if (Regex("/api/households/[A-Za-z0-9-]+/attachments/[A-Za-z0-9-]+/file").matches(path)) receiptPdf = path
                                        }
                                        "print"->{val printer=activity.getSystemService(Context.PRINT_SERVICE) as android.print.PrintManager;printer.print("Budget HQ Pro",v.createPrintDocumentAdapter("Budget HQ Pro"),null)}
                                        "download","saveText"->export(data)
                                    }
                                }
                            })
                            val active=store.token?:return
                            val session=JSONObject().put("kind","budget-device-session").put("token",active).put("user",owner).put("household",store.householdId)
                            v.postWebMessage(WebMessage(session.toString(),arrayOf(ports[1])),origin)
                        }
                        override fun onReceivedError(v:WebView,r:WebResourceRequest,e:WebResourceError) { if(r.isForMainFrame)issue="The mobile workspace could not open." }
                    }
                    loadUrl(origin.toString()+savedPath)
                }},modifier=Modifier.fillMaxSize(),onRelease={v->hostPort[0]?.close();hostPort[0]=null;suite[0]=null;v.stopLoading();v.destroy()})
            }
            market?.let { address->
                Surface(Modifier.fillMaxSize()) { Column {
                    Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) {
                        TextButton(onClick={market=null}){Text("‹  Budget HQ Pro")}
                        TextButton(onClick={charts[0]?.reload()}){Text("Refresh markets")}
                    }
                    AndroidView(factory={ctx->WebView(ctx).apply{
                        charts[0]=this;marketBack=false;configure(this)
                        // Market Pulse authenticates with the site's HttpOnly market cookie and receives no device message port.
                        webViewClient=object:WebViewClient(){
                            override fun shouldOverrideUrlLoading(v:WebView,r:WebResourceRequest):Boolean {
                                if(!r.isForMainFrame)return false
                                if(!r.url.sameOrigin(origin)){external(activity,r.url);return true}
                                if(r.url.isMarket())return false
                                market=null
                                if(r.url.path=="/login")message("Markets could not connect to your account. Open Markets to retry.")
                                else if(!r.url.path.orEmpty().startsWith("/api/"))suite[0]?.loadUrl(r.url.toString())
                                return true
                            }
                            override fun doUpdateVisitedHistory(v:WebView,url:String,reload:Boolean){marketBack=v.canGoBack()}
                        };loadUrl(address)
                    }},modifier=Modifier.fillMaxSize(),onRelease={v->charts[0]=null;v.stopLoading();v.destroy()})
                }}
            }
        }
    }
}
