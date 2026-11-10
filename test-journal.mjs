import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import worker from "./worker/index.js";

class Bucket {
  items = new Map();
  async get(key) {
    const item = this.items.get(key);
    if (!item) return null;
    return {...item, json:async () => JSON.parse(item.body)};
  }
  async put(key, body, {onlyIf,customMetadata}={}) {
    const old = this.items.get(key);
    if (onlyIf?.etagDoesNotMatch === "*" && old) return null;
    if (onlyIf?.etagMatches && old?.etag !== onlyIf.etagMatches) return null;
    const item = {key,body,customMetadata,etag:crypto.randomUUID(),size:body.byteLength};
    this.items.set(key,item);
    return item;
  }
  async list({prefix}) {
    return {objects:[...this.items.values()].filter(item => item.key.startsWith(prefix))};
  }
  async delete(key) { this.items.delete(key); }
}

const env = {BUCKET:new Bucket(),EDITOR_SETUP_CODE:"test-fixture"};
const origin = "https://journal.test";
const call = (path, user, fields, crossOrigin=false) => {
  const headers = {};
  if (user) {
    headers["oai-authenticated-user-id"] = user;
    headers["oai-authenticated-user-email"] = user + "@example.test";
  }
  let body;
  if (fields) {
    headers.Origin = crossOrigin ? "https://other.test" : origin;
    body = new FormData();
    for (const [name,value] of Object.entries(fields)) body.set(name,value);
  }
  return worker.fetch(new Request(origin + path,{headers,body,method:fields ? "POST" : "GET"}),env);
};
const expect = async (path,user,fields,status) => {
  const response = await call(path,user,fields);
  assert.equal(response.status,status,path + " " + user);
  return response;
};
const pdf = new File(["%PDF-1.4\n%%EOF\n"],"test.pdf",{type:"application/pdf"});
const wordType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const wordBytes = Buffer.from(readFileSync(new URL("./test-manuscript.docx.b64",import.meta.url),"utf8"),"base64");
const word = new File([wordBytes],"test.docx",{type:wordType});
await expect("/",null,null,200);
assert.match(await (await expect("/articles",null,null,200)).text(),/awaiting its first/);
await expect("/workspace/setup","editor",{code:"wrong"},403);
await expect("/workspace/setup","editor",{code:"test-fixture"},303);
await expect("/workspace/setup","other",{code:"test-fixture"},403);
const fields = {title:"Management & Administration",authors:"Confidential Author",abstract:"Example abstract",PDF:pdf,anonymous:"yes"};
await expect("/submit",null,fields,401);
assert.equal((await call("/submit","author",fields,true)).status,403);
await expect("/submit","author",{...fields,PDF:new File(["invalid PDF header"],"wrong.pdf")},400);
await expect("/submit","author",{...fields,manuscript:new File(["invalid DOCX content"],"wrong.docx",{type:wordType})},400);
const wordSubmission = await expect("/submit","author",{...fields,manuscript:word},303);
const wordPaper = wordSubmission.headers.get("location");
assert.match(await (await expect(wordPaper,"author",null,200)).text(),/Download anonymized manuscript \(Word/);
await expect(wordPaper + "/manuscript","stranger",null,404);
const draft = await expect("/submit","author",fields,303);
const paper = draft.headers.get("location");
const pub = paper.replace("/workspace/papers","/articles");
await expect(pub,null,null,404);
await expect(pub + "/pdf",null,null,404);
await expect(paper + "/pdf","stranger",null,404);
await expect(paper + "/assign","author",{email:"reviewer@example.test"},403);
await expect(paper + "/assign","editor",{email:"reviewer@example.test"},303);
await expect(paper + "/assign","editor",{email:"reviewer@example.test"},409);
assert.match(await (await expect(paper,"editor",null,200)).text(),/mailto:reviewer/);
assert.doesNotMatch(await (await expect(paper,"reviewer",null,200)).text(),/Confidential Author/);
assert.equal(await (await expect(paper + "/pdf","reviewer",null,200)).text(),await pdf.text());
await expect(paper + "/decide","editor",{decision:"accepted",note:"Too early"},409);
await expect(paper + "/review","reviewer",{recommendation:"minor",report:"Confidential review"},303);
await expect(paper + "/review","reviewer",{recommendation:"minor",report:"Duplicate review"},403);
assert.doesNotMatch(await (await expect(paper,"author",null,200)).text(),/Confidential review|reviewer@example.test/);
await expect(paper + "/decide","editor",{decision:"revision",note:"Revise the methods"},303);
await expect(paper + "/pdf","reviewer",null,404);
await expect(paper + "/revise","author",{manuscript:word,response:"Updated methods"},303);
await expect(paper,"reviewer",null,404);
await expect(paper + "/assign","editor",{email:"reviewer@example.test"},303);
const wordDownload = await expect(paper + "/manuscript","reviewer",null,200);
assert.equal(wordDownload.headers.get("content-type"),wordType);
assert.match(wordDownload.headers.get("content-disposition"),/\.docx"$/);
assert.deepEqual(Buffer.from(await wordDownload.arrayBuffer()),wordBytes);
await expect(paper + "/pdf","reviewer",null,404);
await expect(paper + "/review","reviewer",{recommendation:"accept",report:"Methods improved"},303);
await expect(paper + "/decide","editor",{decision:"accepted",note:"Accepted"},303);
await expect(pub,null,null,404);
await expect(paper + "/publish","author",{PDF:pdf,confirm:"yes"},403);
await expect(paper + "/publish","editor",{PDF:word,confirm:"yes"},400);
await expect(paper + "/publish","editor",{PDF:pdf,confirm:"yes"},303);
assert.match(await (await expect(pub,null,null,200)).text(),/Confidential Author/);
assert.match(await (await expect("/articles",null,null,200)).text(),/Management &amp; Administration/);
assert.equal(await (await expect(pub + "/pdf",null,null,200)).text(),await pdf.text());
await expect(paper + "/pdf","reviewer",null,404);
console.log("Journal workflow and access checks passed.");
