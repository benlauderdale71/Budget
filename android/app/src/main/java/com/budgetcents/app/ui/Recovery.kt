package com.budgetcents.app.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import com.budgetcents.app.BudgetApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

@Composable
internal fun HouseholdRecovery(api:BudgetApi,hid:String,role:String) {
    val scope=rememberCoroutineScope()
    val context=LocalContext.current
    var busy by remember(hid){mutableStateOf(false)}
    var status by remember(hid){mutableStateOf("")}
    var draft by remember(hid){mutableStateOf<JSONObject?>(null)}
    val base="/api/households/"+hid
    val save=rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")){uri->
        if(uri!=null)scope.launch {
            busy=true
            try {
                withContext(Dispatchers.IO){
                    val backup=api.request("GET",base+"/backup")
                    context.contentResolver.openOutputStream(uri,"wt")?.bufferedWriter()?.use{it.write(backup.toString())}?:error("Could not write the backup.")
                }
                status="Backup saved."
            }catch(e:Exception){status=e.message.orEmpty()}finally{busy=false}
        }
    }
    val open=rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()){uri->
        draft=null
        if(uri!=null)scope.launch {
            busy=true
            try {
                val (file,preview)=withContext(Dispatchers.IO){
                    val file=JSONObject(context.contentResolver.openInputStream(uri)?.bufferedReader()?.use{it.readText()}?:error("Could not open backup."))
                    file to api.request("POST",base+"/restore",JSONObject().put("mode","preview").put("backup",file))
                }
                val adds=preview.getJSONObject("adds")
                status=adds.keys().asSequence().filter{adds.optInt(it)>0}.joinToString(", "){it+" "+adds.optInt(it)}+
                    " · "+preview.optInt("skipped")+" existing. "+preview.getJSONArray("warnings").let{a->(0 until a.length()).joinToString(" "){a.getString(it)}}
                draft=file
            }catch(e:Exception){status=e.message.orEmpty()}finally{busy=false}
        }
    }
    Text("Download the ledger, statement evidence, catch-up plans, corrections and visible inventory files.")
    Button(enabled=!busy,onClick={save.launch("budget-hq-pro-backup.json")}){Text("Save household backup")}
    if(role in listOf("owner","admin")) {
        Button(enabled=!busy,onClick={open.launch(arrayOf("application/json","text/plain","application/octet-stream"))}){Text("Preview a backup")}
        draft?.let { file ->
            Button(enabled=!busy,onClick={scope.launch{
                busy=true
                try {withContext(Dispatchers.IO){api.request("POST",base+"/restore",JSONObject().put("mode","add-missing").put("backup",file))}
                    draft=null;status="Missing records restored."
                }catch(e:Exception){status=e.message.orEmpty()}finally{busy=false}
            }}){Text("Restore missing records")}
        }
    }
    Text(status)
}
