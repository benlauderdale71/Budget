import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import sharp from "sharp";
import { billHeader, billImportDate, parseCsv, type BillImportGrid } from "@budgetcents/domain";

export interface BillDocumentRead { grids: BillImportGrid[]; text: string; format: string; warnings: string[]; pages: number }
type Word = { x: number; y: number; w: number; h: number; text: string };

let activeReaders = 0;
export async function readBillDocument(bytes: Buffer, filename: string): Promise<BillDocumentRead> {
  if (activeReaders >= 2) throw new Error("The document reader is busy. Please try again shortly.");
  activeReaders++;
  try { return await readDocument(bytes, filename); }
  finally { activeReaders--; }
}

async function readDocument(bytes: Buffer, filename: string): Promise<BillDocumentRead> {
  if (!bytes.length || bytes.length > 8_000_000) throw new Error("Choose a file no larger than 8 MB.");
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "csv") {
    let text: string;
    try { text = new TextDecoder(bytes[0]===0xff&&bytes[1]===0xfe?"utf-16le":bytes[0]===0xfe&&bytes[1]===0xff?"utf-16be":"utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error("The CSV text encoding could not be read. Save the spreadsheet as CSV UTF-8 and upload it again."); }
    const rows = parseCsv(text);
    if (rows.length > 1001 || rows.some((row) => row.length > 60 || row.some((cell) => cell.length > 4000))) throw new Error("Use a CSV with at most 1,000 data rows, 60 columns and 4,000 characters per cell.");
    return { grids: [{ name: "CSV", rows }], text, format: "csv", warnings: [], pages: 1 };
  }
  if (ext === "xls" || ext === "xlsx") {
    const ole = bytes.subarray(0, 8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]));
    const zip = bytes.subarray(0, 4).equals(Buffer.from([0x50,0x4b,0x03,0x04]));
    if (!ole && !zip) throw new Error("This is not a readable Excel workbook. Export it as CSV or use a real XLS/XLSX file.");
    if (zip) checkZipSize(bytes);
    const grids = await excel(bytes);
    return { grids, text: grids.map((grid) => `${grid.name}\n${grid.rows.map((row) => row.join("\t")).join("\n")}`).join("\n"), format: ext, warnings: ["Excel formulas are not run. Cached values are shown for review. All sheets are read, including hidden sheets."], pages: grids.length };
  }
  const pdf = bytes.subarray(0, 5).toString() === "%PDF-";
  const dir = await mkdtemp(join(tmpdir(), "budgetcents-bills-"));
  try {
    if (pdf) {
      const path = join(dir, "document.pdf"); await writeFile(path, bytes);
      const info = await run(process.env.BUDGETCENTS_PDFINFO || "pdfinfo", [path]);
      const count = Number(info.match(/Pages:\s+(\d+)/)?.[1]);
      if (!count || count > 8) throw new Error("PDF uploads support up to 8 pages. Split larger documents before uploading.");
      const grids: BillImportGrid[] = [], texts: string[] = [];
      for (let page = 1; page <= count; page++) {
        const text = await run(process.env.BUDGETCENTS_PDFTOTEXT || "pdftotext", ["-layout", "-f", String(page), "-l", String(page), path, "-"]);
        if ((text.match(/[a-z]/gi)?.length ?? 0) >= 20) { texts.push(text); grids.push(wordsToGrid(textWords(text), `PDF page ${page}`, false)); }
        else {
          const prefix = join(dir, `scan-${page}`);
          await run(process.env.BUDGETCENTS_PDFTOPPM || "pdftoppm", ["-f", String(page), "-l", String(page), "-singlefile", "-png", "-scale-to", "2600", path, prefix]);
          const read = await image(await readFile(`${prefix}.png`), dir, `PDF page ${page}`);
          texts.push(read.text); grids.push(read.grid);
        }
      }
      return { grids, text: texts.join("\n\n"), format: "pdf", pages: count, warnings: ["Every PDF page was read. Check extracted amounts and dates against the original."] };
    }
    // Sharp validates image signatures and pixel limits, regardless of the supplied name.
    if (!["png", "jpg", "jpeg", "webp"].includes(ext ?? "")) throw new Error("Use PNG, JPG, WebP, PDF, CSV, XLS or XLSX.");
    const read = await image(bytes, dir, "Image");
    return { grids: [read.grid], text: read.text, format: "image", pages: 1, warnings: ["Images are read privately on the app server. Check recognition carefully, especially small text and handwritten entries."] };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function checkZipSize(bytes: Buffer) {
  let total = 0, files = 0;
  for (let i = 0; i + 46 <= bytes.length; i++) if (bytes.readUInt32LE(i) === 0x02014b50) {
    total += bytes.readUInt32LE(i + 24); files++;
    if (total > 64_000_000 || files > 2000) throw new Error("The workbook expands beyond the upload limit. Export just the bill sheet as CSV.");
    i += 45 + bytes.readUInt16LE(i + 28) + bytes.readUInt16LE(i + 30) + bytes.readUInt16LE(i + 32);
  }
}

function excel(bytes: Buffer): Promise<BillImportGrid[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./bill-excel-worker.cjs", import.meta.url), { workerData: bytes, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error("The spreadsheet reader timed out. Export a smaller sheet as CSV.")); }, 15000);
    worker.once("message", (result) => { clearTimeout(timer); void worker.terminate(); result.error ? reject(new Error(result.error)) : resolve(result.grids); });
    worker.once("error", () => { clearTimeout(timer); reject(new Error("The workbook could not be read within the memory limit. Export it as CSV.")); });
    worker.once("exit", (code) => { clearTimeout(timer); if (code !== 0) reject(new Error("The workbook reader stopped. Export a smaller sheet as CSV.")); });
  });
}

async function image(bytes: Buffer, dir: string, name: string): Promise<{grid: BillImportGrid; text: string}> {
  const { data, info } = await sharp(bytes, { limitInputPixels: 12_000_000 }).rotate().flatten({ background: "#fff" }).grayscale().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  if (w < 40 || h < 40 || w > 8000 || h > 8000) throw new Error("Use an image at least 40 pixels wide and no larger than 12 megapixels.");
  const out = Buffer.from(data), xs: number[] = [], ys: number[] = [];
  // Spreadsheet screenshots can include a dark row-number gutter. It is not bill data.
  let gutter = 0;
  for (let x=0; x<Math.min(50,w*.05); x++) {
    let dark=0; for(let y=0;y<h;y++) if(data[y*w+x]<65) dark++;
    if(dark/h<.5) break;
    gutter=x+1;
  }
  // Remove long grid lines before OCR, retaining their positions for cell reconstruction.
  for (let y = 0; y < h; y++) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      if (x < w && data[y*w+x] < 65) { if (start < 0) start = x; }
      else if (start >= 0) { if (x-start > w*.18) { for (let k=start;k<x;k++) out[y*w+k]=255; if (x-start>w*.45) ys.push(y); } start=-1; }
    }
  }
  for (let x = 0; x < w; x++) {
    let start = -1;
    for (let y = 0; y <= h; y++) {
      if (y < h && data[y*w+x] < 65) { if (start < 0) start = y; }
      else if (start >= 0) { if (y-start > h*.18) { for (let k=start;k<y;k++) out[k*w+x]=255; if (y-start>h*.65) xs.push(x); } start=-1; }
    }
  }
  const scale = Math.min(3, 3600/w, Math.sqrt(12_000_000/(w*h)));
  const xx=cluster(xs), yy=cluster(ys);
  const spacings=yy.slice(1).map((value,i)=>value-yy[i]).sort((a,b)=>a-b);
  const top=yy.length>5 ? Math.max(0,yy[0]-(spacings[Math.floor(spacings.length/2)] ?? yy[0])) : 0;
  const read = async (pixels:Buffer, suffix:string):Promise<Word[]> => {
    const path=join(dir,`ocr-${suffix}.png`);
    await sharp(pixels,{raw:{width:w,height:h,channels:1}}).resize(Math.round(w*scale)).withMetadata({density:200}).png().toFile(path);
    const tsv=await run(process.env.BUDGETCENTS_TESSERACT||"tesseract",[path,"stdout","-l","eng","--psm","6","tsv"]);
    return tsv.split("\n").slice(1).flatMap(line=>{const p=line.split("\t"),text=p.slice(11).join("\t").trim();return p[0]==="5"&&text&&!/^[=—_~|.\-]+$/.test(text)?[{x:Number(p[6])/scale,y:Number(p[7])/scale,w:Number(p[8])/scale,h:Number(p[9])/scale,text}]:[];});
  };
  const words=await read(out,"table");
  const hasGrid=xx.length>=4&&xx.length<60&&yy.length>=5&&yy.length<1001;
  const grid=hasGrid?gridFromBoundaries(words,[0,...xx,w],[top,...yy,h],name):wordsToGrid(words,name,true);
  if(hasGrid&&gutter&&billHeader(grid.rows[0]?.[0]??"")==="date") {
    const full=Buffer.from(out);
    for(let y=0;y<h;y++) for(let x=0;x<gutter;x++) full[y*w+x]=255;
    const fullDates=gridFromBoundaries(await read(full,"unguttered"),[0,...xx,w],[top,...yy,h],name);
    const clean=Buffer.alloc(out.length,255);
    for(let y=0;y<h;y++) for(let x=gutter;x<xx[0];x++) clean[y*w+x]=out[y*w+x]<150?0:255;
    const dates=gridFromBoundaries(await read(clean,"dates"),[0,...xx,w],[top,...yy,h],name);
    for(let r=1;r<grid.rows.length;r++) {
      const value=fullDates.rows[r][0];
      grid.rows[r][0]=billImportDate(value,"2000-01").date?value:dates.rows[r][0];
    }
  }
  return { grid, text: grid.rows.map((row)=>row.join("\t")).join("\n") };
}

function cluster(values: number[]): number[] {
  const groups:number[][]=[];
  for (const value of [...new Set(values)].sort((a,b)=>a-b)) { const last=groups[groups.length-1]; if (last && value-last[last.length-1]<=2) last.push(value); else groups.push([value]); }
  return groups.map(group=>(group[0]+group[group.length-1])/2);
}
function gridFromBoundaries(words: Word[], xs:number[], ys:number[], name:string): BillImportGrid {
  const rows = Array.from({length:ys.length-1},()=>Array<string>(xs.length-1).fill(""));
  for (const word of words.sort((a,b)=>a.x-b.x)) {
    const x=word.x+Math.min(word.w/2,3), y=word.y+word.h/2;
    const c=xs.findIndex((edge,i)=>i<xs.length-1 && x>=edge && x<xs[i+1]);
    const r=ys.findIndex((edge,i)=>i<ys.length-1 && y>=edge && y<ys[i+1]);
    if (c>=0 && r>=0) rows[r][c]+=(rows[r][c]?" ":"")+word.text;
  }
  return {name,rows,ocr:true};
}
function textWords(text:string): Word[] {
  return text.split(/\r?\n/).flatMap((line,y)=>[...line.matchAll(/\S+/g)].map(match=>({x:match.index!, y:y*10, w:match[0].length,h:8,text:match[0]})));
}
function wordsToGrid(words:Word[],name:string,ocr:boolean): BillImportGrid {
  const lines:Word[][]=[];
  for(const word of [...words].sort((a,b)=>a.y-b.y || a.x-b.x)) { const last=lines[lines.length-1]; if(last && Math.abs((last[0].y+last[0].h/2)-(word.y+word.h/2))<Math.max(last[0].h,word.h)*.6) last.push(word); else lines.push([word]); }
  let columns:number[]=[];
  for(const line of lines) {
    const sorted=line.sort((a,b)=>a.x-b.x), found:{x:number;field:string}[]=[];
    for(let i=0;i<sorted.length;i++) for(let length=Math.min(3,sorted.length-i);length>=1;length--) {
      const field=billHeader(sorted.slice(i,i+length).map(word=>word.text).join(" "));
      if(field){found.push({x:sorted[i].x,field});i+=length-1;break;}
    }
    if(found.some(item=>["name","income","estimate"].includes(item.field)) && found.some(item=>["amount","monthly","annual"].includes(item.field))) { columns=found.map(item=>item.x-1);break; }
  }
  if(!columns.length) return {name,rows:lines.map(line=>[line.map(word=>word.text).join(" ")]),ocr};
  columns[0]=-1;
  return {name,ocr,rows:lines.map(line=>{const row=Array<string>(columns.length).fill("");for(const word of line){let i=columns.findIndex((x,n)=>word.x>=x&&(n===columns.length-1||word.x<columns[n+1]));if(i<0)i=0;row[i]+=(row[i]?" ":"")+word.text;}return row;})};
}
function run(command:string,args:string[]):Promise<string> {
  return new Promise((resolve,reject)=>execFile(command,args,{timeout:25000,maxBuffer:3_000_000},(error,stdout)=>error ? reject(new Error("The document reader could not finish. Try a clearer image, an unlocked PDF, or a CSV/Excel export.")) : resolve(String(stdout))));
}
