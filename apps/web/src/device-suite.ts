let port:MessagePort|null=null;
let deviceToken="";
let owner="";
export const isDeviceSuite=()=>typeof document!=="undefined" && document.documentElement.dataset.budgetDevice==="1";
export const sessionToken=()=>isDeviceSuite()?deviceToken:localStorage.getItem("budgetcents.token");
export const deviceOwner=()=>owner;

export function connectDevice():Promise<void> {
  if (!isDeviceSuite()) return Promise.resolve();
  return new Promise(resolve=>{
    function receive(e:MessageEvent) {
      if (typeof e.data!=="string" || e.ports.length!==1) return;
      let data;
      try { data=JSON.parse(e.data); } catch { return; }
      if (data.kind!=="budget-device-session" || typeof data.token!=="string" || !data.token || typeof data.user!=="string" || !data.user) return;
      window.removeEventListener("message",receive);
      port=e.ports[0];deviceToken=data.token;owner=data.user;
      if(localStorage.getItem("budgetcents.userId")!==owner) {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith("budgetcents.") && key!=="budgetcents.queue") localStorage.removeItem(key);
        }
      }
      if(data.household) localStorage.setItem("budgetcents.household",data.household);
      resolve();
    }
    window.addEventListener("message",receive);
  });
}
export function endDeviceSession() {
  if(!deviceToken)return;
  deviceToken="";owner="";port?.postMessage(JSON.stringify({action:"signOut"}));
}
export function deviceHousehold(id:string) { if(id) port?.postMessage(JSON.stringify({action:"household",id})); }
export function openDeviceMarkets(path:string) { port?.postMessage(JSON.stringify({action:"markets",path})); }
export function openDeviceTools() { port?.postMessage(JSON.stringify({action:"deviceTools"})); }
export function openDeviceReceipt(path: string) { port?.postMessage(JSON.stringify({action:"receiptPdf",path})); }
export function printPage() { if(port)port.postMessage(JSON.stringify({action:"print"}));else window.print(); }
export function deviceDownload(path:string,name:string) {
  if(!port)return false;
  port.postMessage(JSON.stringify({action:"download",path,name}));return true;
}
export function saveTextFile(text:string,name:string,mime:string) {
  if(port) { port.postMessage(JSON.stringify({action:"saveText",text,name,mime}));return; }
  const url=URL.createObjectURL(new Blob([text],{type:mime})),a=document.createElement("a");
  a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
