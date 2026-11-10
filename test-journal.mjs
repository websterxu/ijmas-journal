import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
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
    for (const [name,value] of Object.entries(fields)) {
      for (const entry of Array.isArray(value) ? value : [value]) body.append(name,entry);
    }
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
const dashboard = "/workspace/site";
const settings = {
  version:"new",
  introduction:"Research on leadership & governance",
  announcement:"<script>example</script>",
  scope:"We welcome management case studies.",
  preparation:"Prepare an anonymized file.",
  review:"Peer review precedes the publication decision.",
  contact:"editor@example.test"
};
assert.match(await (await expect("/",null,null,200)).text(),/A forum for research/);
assert.match(await (await expect("/guidelines",null,null,200)).text(),/Prepare the title/);
assert.match(await (await expect("/workspace","editor",null,200)).text(),/Owner dashboard/);
assert.doesNotMatch(await (await expect("/workspace","author",null,200)).text(),/Owner dashboard/);
assert.match(await (await expect(dashboard,null,null,200)).text(),/Sign in to IJMAS/);
await expect(dashboard,null,settings,401);
await expect(dashboard,"author",null,403);
await expect(dashboard,"reviewer",settings,403);
assert.equal((await call(dashboard,"editor",settings,true)).status,403);
await expect(dashboard,"editor",{...settings,contact:"invalid"},400);
await expect(dashboard,"editor",{...settings,introduction:"x".repeat(1201)},400);
assert.equal((await expect(dashboard,"editor",settings,303)).headers.get("location"),dashboard + "?saved=1");
await expect(dashboard,"editor",settings,409);
const homepage = await (await expect("/",null,null,200)).text();
assert.match(homepage,/Research on leadership &amp; governance/);
assert.match(homepage,/&lt;script&gt;example&lt;\/script&gt;/);
assert.doesNotMatch(homepage,/<script>/);
assert.match(homepage,/href="mailto:editor@example.test"/);
const updatedGuidelines = await (await expect("/guidelines",null,null,200)).text();
assert.match(updatedGuidelines,/We welcome management case studies/);
assert.match(updatedGuidelines,/Prepare an anonymized file/);
assert.match(updatedGuidelines,/Peer review precedes/);
const editorPage = await (await expect(dashboard + "?saved=1","editor",null,200)).text();
assert.match(editorPage,/Website content saved/);
assert.match(editorPage,/Research on leadership &amp; governance/);
const [,version] = editorPage.match(/name="version" value="([^"]+)"/);
await expect(dashboard,"editor",{...settings,version,announcement:"",contact:""},303);
assert.doesNotMatch(await (await expect("/",null,null,200)).text(),/Announcement|Contact the journal/);
const fields = {title:"Management & Administration",authors:"Confidential Author",abstract:"Example abstract",PDF:pdf,anonymous:"yes"};
const submissionPage = await expect("/submit","author",null,200);
assert.match(submissionPage.headers.get("content-security-policy"),/script-src 'self'/);
const submissionHtml = await submissionPage.text();
assert.equal([...submissionHtml.matchAll(/name="author"/g)].length,7);
assert.match(submissionHtml,/Add next author/);
const authorScript = await expect("/assets/author-fields.js",null,null,200);
assert.match(authorScript.headers.get("content-type"),/^text\/javascript/);
let addAuthor;
const addButton = {hidden:true,addEventListener:(_, handler) => {addAuthor = handler;}};
const authorRows = Array.from({length:6},() => ({
  hidden:false,
  focused:false,
  querySelector() { return {focus:() => {this.focused = true;}}; }
}));
const authorGroup = {querySelector:() => addButton,querySelectorAll:() => authorRows};
runInNewContext(await authorScript.text(),{document:{getElementById:() => authorGroup}});
assert.equal(addButton.hidden,false);
assert.ok(authorRows.every(row => row.hidden));
for (const [index,row] of authorRows.entries()) {
  addAuthor();
  assert.equal(row.focused,true);
  assert.equal(authorRows.filter(row => !row.hidden).length,index + 1);
}
assert.equal(addButton.hidden,true);
const authorNames = ["Confidential Author","Author Two","Author Three","Author Four","Author Five","Author Six","Author Seven"];
await expect("/submit","author",{...fields,author:[...authorNames,"Author Eight"]},400);
await expect("/submit","author",{...fields,authors:[...authorNames,"Author Eight"].join("; ")},400);
await expect("/submit","author",{...fields,author:["Author One; Author Two"]},400);
await expect("/submit","author",{...fields,author:["","Second Author"]},400);
await expect("/submit",null,fields,401);
assert.equal((await call("/submit","author",fields,true)).status,403);
await expect("/submit","author",{...fields,PDF:new File(["invalid PDF header"],"wrong.pdf")},400);
await expect("/submit","author",{...fields,manuscript:new File(["invalid DOCX content"],"wrong.docx",{type:wordType})},400);
const wordSubmission = await expect("/submit","author",{...fields,author:["Single Author","","","","","",""],manuscript:word},303);
const wordPaper = wordSubmission.headers.get("location");
assert.match(await (await expect(wordPaper,"author",null,200)).text(),/Download anonymized manuscript \(Word/);
assert.match(await (await expect(wordPaper,"author",null,200)).text(),/Single Author/);
await expect(wordPaper + "/manuscript","stranger",null,404);
const draft = await expect("/submit","author",{...fields,author:authorNames},303);
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
const articleHtml = await (await expect(pub,null,null,200)).text();
assert.ok(articleHtml.includes(authorNames.join("; ")));
assert.deepEqual([...articleHtml.matchAll(/name="citation_author" content="([^"]+)"/g)].map(match => match[1]),authorNames);
assert.match(await (await expect("/articles",null,null,200)).text(),/Management &amp; Administration/);
assert.equal(await (await expect(pub + "/pdf",null,null,200)).text(),await pdf.text());
await expect(paper + "/pdf","reviewer",null,404);
console.log("Journal workflow and access checks passed.");
