package com.budgetcents.app.ui

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.budgetcents.app.Store
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.roundToInt

@Composable
internal fun ReceiptPdf(path: String, store: Store, owner: String, close: () -> Unit) {
    val context = LocalContext.current
    var file by remember(path) { mutableStateOf<File?>(null) }
    var page by remember(path) { mutableIntStateOf(0) }
    var pages by remember(path) { mutableIntStateOf(0) }
    var image by remember(path) { mutableStateOf<Bitmap?>(null) }
    var error by remember(path) { mutableStateOf("") }
    LaunchedEffect(path, owner) {
        val copy = File.createTempFile("receipt-preview-", ".pdf", context.cacheDir)
        try {
            withContext(Dispatchers.IO) { copyApiFile(store, path, copy, owner) }
            file = copy
            awaitCancellation()
        } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
        catch (_: Exception) { error = "This PDF could not be opened." }
        finally { copy.delete() }
    }
    LaunchedEffect(file, page) {
        val local = file ?: return@LaunchedEffect
        image = null
        try {
            val rendered = withContext(Dispatchers.IO) {
                PdfRenderer(ParcelFileDescriptor.open(local, ParcelFileDescriptor.MODE_READ_ONLY)).use { document ->
                    document.openPage(page).use { source ->
                        val scale = 1750f / maxOf(source.width, source.height, 1)
                        val bitmap = Bitmap.createBitmap(maxOf(1,(scale*source.width).roundToInt()),
                            maxOf(1,(scale*source.height).roundToInt()), Bitmap.Config.ARGB_8888)
                        bitmap.eraseColor(Color.WHITE)
                        source.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        Pair(document.pageCount, bitmap)
                    }
                }
            }
            pages = rendered.first
            image = rendered.second
        } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
        catch (_: Exception) { error = "This PDF page could not be displayed." }
    }
    Dialog(onDismissRequest=close, properties=DialogProperties(usePlatformDefaultWidth=false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.safeDrawingPadding().padding(12.dp)) {
                TextButton(onClick=close) { Text("‹  Back to receipt") }
                val shown = image
                if (error.isNotEmpty()) Text(error)
                else if (shown == null) CircularProgressIndicator()
                else Image(shown.asImageBitmap(), "Receipt page ${page+1}", Modifier.fillMaxWidth().weight(1f))
                if (pages > 1) Row(Modifier.fillMaxWidth(), horizontalArrangement=Arrangement.SpaceBetween) {
                    TextButton(onClick={ page-- }, enabled=page>0) { Text("Previous") }
                    Text("${page+1} / $pages")
                    TextButton(onClick={ page++ }, enabled=page+1<pages) { Text("Next") }
                }
            }
        }
    }
}
