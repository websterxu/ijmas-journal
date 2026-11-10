const NAME = "International Journal of Management and Administration Studies";
const SITE_DASHBOARD = "/workspace/site";
const SITE_SETTINGS = "settings/public-content.json";
const SITE_FIELDS = {
  introduction: {label:"Homepage introduction", max:1200, initial:"A forum for research on how organizations are managed and how institutions are administered."},
  announcement: {label:"Homepage announcement (optional)", max:1500, initial:""},
  scope: {label:"Guidelines introduction", max:1200, initial:"IJMAS welcomes original research, theoretical work, and review articles in management and administration studies."},
  preparation: {label:"Submission instructions", max:6000, initial:"1. Prepare the title, author names in publication order, and abstract.\n2. Save the anonymized manuscript as a PDF or Word (.docx) file. Remove author names, affiliations, acknowledgments, and identifying file metadata. In Word, also clear comments and resolve tracked changes.\n3. Sign in and upload the manuscript. Track its status in your workspace."},
  review: {label:"Review and publication guidance", max:6000, initial:"Editors assign reviewers to the anonymized manuscript. Reviewers submit recommendations and comments. Editors communicate decisions through the author workspace and can request a revised manuscript.\n\nFollowing acceptance, the editor verifies and uploads the final publication PDF. Readers can access published PDFs without signing in."},
  contact: {label:"Public contact email (optional)", max:254, initial:""}
};
const MAX = 10 * 1024 * 1024;
const FORMATS = {
  pdf:"application/pdf",
  docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};
const ID = /^[a-f0-9-]{36}$/;
const state = {submitted:"Submitted", reviewing:"Under review", revision:"Revision requested", accepted:"Accepted", rejected:"Declined", published:"Published"};
const recommendations = {accept:"Accept", minor:"Minor revisions", major:"Major revisions", reject:"Decline"};
const e = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const para = (v) => e(v).replaceAll("\n", "<br>");
const now = () => new Date().toISOString();
const date = (v) => v.slice(0, 10);
const key = (id) => "papers/" + id + ".json";
const signIn = (path,github) => (github ? "/oauth/start" : "/signin-with-chatgpt") + "?return_to=" + encodeURIComponent(path);
const header = {"X-Content-Type-Options":"nosniff", "Referrer-Policy":"same-origin", "Cache-Control":"no-store", "X-Frame-Options":"DENY"};
const redirect = (path) => new Response(null, {status:303,headers:{...header,Location:path}});
const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };

function identity(request, provider) {
  const id = request.headers.get("oai-authenticated-user-id");
  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  return id && email ? {id,email,provider} : null;
}

async function read(bucket, path) {
  const item = await bucket.get(path);
  return item ? {data:await item.json(), etag:item.etag} : null;
}

async function write(bucket, data, etag) {
  const saved = await bucket.put(key(data.id), JSON.stringify(data), {
    onlyIf: etag ? {etagMatches:etag} : {etagDoesNotMatch:"*"},
    customMetadata: {status:data.status, created:data.created}
  });
  if (!saved) fail(409,"This manuscript was updated in another session. Reload it and try again.");
}

async function list(bucket, filter) {
  const records = [];
  let cursor;
  do {
    const page = await bucket.list({prefix:"papers/", include:["customMetadata"], limit:100, cursor});
    const batch = page.objects.filter(filter);
    for (let offset = 0; offset < batch.length; offset += 15) {
      const loaded = await Promise.all(batch.slice(offset,offset+15).map(o => read(bucket,o.key)));
      records.push(...loaded.filter(Boolean).map(r => r.data));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return records.sort((a,b) => b.created.localeCompare(a.created));
}

function field(form, name, max, required=true) {
  const value = form.get(name);
  const clean = typeof value === "string" ? value.trim() : "";
  if ((required && !clean) || clean.length > max) fail(400,"Check the " + name + " field.");
  return clean;
}

function isWordDocument(bytes) {
  if (bytes.byteLength < 22) return false;
  const zip = new DataView(bytes);
  if (zip.getUint32(0,true) !== 0x04034b50) return false;
  // Read the ZIP directory without extracting any document content.
  for (let end = zip.byteLength - 22; end >= Math.max(0,zip.byteLength - 65557); end--) {
    if (zip.getUint32(end,true) !== 0x06054b50 || end + 22 + zip.getUint16(end + 20,true) !== zip.byteLength) continue;
    if (zip.getUint32(end + 4,true) !== 0) return false;
    const count = zip.getUint16(end + 10,true);
    let offset = zip.getUint32(end + 16,true);
    if (offset + zip.getUint32(end + 12,true) !== end || zip.getUint16(end + 8,true) !== count) return false;
    const required = new Set(["[Content_Types].xml","_rels/.rels","word/document.xml"]);
    const decoder = new TextDecoder();
    for (let index = 0; index < count; index++) {
      if (offset + 46 > end || zip.getUint32(offset,true) !== 0x02014b50 || (zip.getUint16(offset + 8,true) & 1)) return false;
      const nameLength = zip.getUint16(offset + 28,true);
      const next = offset + 46 + nameLength + zip.getUint16(offset + 30,true) + zip.getUint16(offset + 32,true);
      const local = zip.getUint32(offset + 42,true);
      if (next > end || local + 30 > offset || zip.getUint32(local,true) !== 0x04034b50) return false;
      const name = decoder.decode(new Uint8Array(bytes,offset + 46,nameLength));
      if (name.toLowerCase().endsWith("/vbaproject.bin")) return false;
      required.delete(name);
      offset = next;
    }
    return offset === end && required.size === 0;
  }
  return false;
}

async function replaceFile(bucket, paper, form, type, etag) {
  const manuscript = type === "manuscript";
  const file = manuscript ? form.get("manuscript") ?? form.get("PDF") : form.get("PDF");
  const format = /\.(pdf|docx)$/i.exec(file?.name ?? "")?.[1].toLowerCase();
  if (!file || typeof file === "string" || file.size < 12 || file.size > MAX ||
      (format !== "pdf" && !(manuscript && format === "docx")) ||
      ![FORMATS[format],"application/octet-stream",format === "docx" ? "application/zip" : ""].includes(file.type)) {
    fail(400,manuscript ? "Select a PDF or Word (.docx) file up to 10 MB." : "Select a PDF up to 10 MB.");
  }
  const bytes = await file.arrayBuffer();
  if (format === "docx") {
    if (!isWordDocument(bytes)) fail(400,"The selected file is not a supported Word (.docx) document.");
  } else if (!/^%PDF-\d\.\d/.test(new TextDecoder().decode(bytes.slice(0,8)))) {
    fail(400,"The selected file does not have a valid PDF header.");
  }
  const path = "files/" + paper.id + "/" + crypto.randomUUID() + "." + format;
  await bucket.put(path, bytes, {httpMetadata:{contentType:FORMATS[format]}});
  paper[type] = path;
  try {
    await write(bucket,paper,etag);
  } catch (error) {
    if (error.status === 409) await bucket.delete(path);
    throw error;
  }
}

async function download(bucket, path, id, published) {
  const object = path && await bucket.get(path);
  if (!object) fail(404,"This PDF is unavailable.");
  const format = path.endsWith(".docx") ? "docx" : "pdf";
  return new Response(object.body,{headers:{...header,"Content-Type":FORMATS[format],
    "Content-Disposition":'attachment; filename="ijmas-' + id + '.' + format + '"',
    "Content-Length":String(object.size),
    "Cache-Control":published ? "public, max-age=300" : "private, no-store"}});
}

function shell(title, body, person, status=200, meta="") {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(title)} | IJMAS</title>${meta}<style>${CSS}</style></head><body>
  <header><div class="bar"><a class="brand" href="/" aria-label="IJMAS home">IJ<span>MAS</span></a><nav aria-label="Main navigation"><a href="/articles">Articles</a><a href="/guidelines">Author guidelines</a><a href="/workspace">Workspace</a>${person ? '<a href="' + (person.provider === "github" ? "/oauth/logout" : "/signout-with-chatgpt?return_to=%2F") + '">Sign out</a>' : ''}</nav></div></header>
  <main>${body}</main><footer><div class="foot"><strong>IJMAS</strong><span>${NAME}</span><a href="/guidelines">Submission guidelines</a></div></footer></body></html>`,{status,headers:{...header,"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"}});
}

const CSS = `*{box-sizing:border-box}html{color-scheme:light}body{margin:0;color:#172437;background:#f9f8f4;font:16px/1.6 system-ui,sans-serif}a{color:#145d53;text-underline-offset:4px}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #c37827;outline-offset:3px}header{background:#13253a;color:#fff}.bar,.foot{max-width:1140px;margin:auto;padding:18px 26px;display:flex;gap:24px;align-items:center;justify-content:space-between;flex-wrap:wrap}.brand{font:bold 28px Georgia,serif;letter-spacing:.06em;text-decoration:none;color:#fff}.brand span{color:#e3be81}nav{display:flex;gap:20px;flex-wrap:wrap}nav a{color:#fff;text-decoration:none;font-size:.94rem}nav a:hover{text-decoration:underline}main{max-width:1140px;min-height:70vh;padding:48px 26px 70px;margin:auto}.hero{background:#172d45;color:#fff;border-radius:8px;padding:clamp(28px,6vw,70px);border-bottom:5px solid #d9ae69;position:relative}.hero .kicker{color:#efd099}.hero h1{max-width:850px;font-size:clamp(2.45rem,6vw,4.5rem);margin:12px 0 20px}.hero p{max-width:630px;color:#e0e9f1}.hero .button{background:#f1cc8f;color:#182838}.hero .secondary{background:transparent;color:white;border:1px solid #b6c4d0}h1,h2,h3{font-family:Georgia,serif;line-height:1.14}h1{font-size:clamp(2.2rem,5vw,3.65rem);margin:.2em 0 .45em}h2{font-size:1.85rem;margin:.3em 0 .6em}h3{font-size:1.32rem;margin:.25em 0 .45em}.kicker{font-size:.75rem;font-weight:800;letter-spacing:.15em;text-transform:uppercase;color:#566452}.intro{color:#4c5c67;max-width:720px}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:22px}.button,button{display:inline-block;background:#15594e;color:#fff;padding:10px 16px;border:1px solid transparent;border-radius:5px;text-decoration:none;font:inherit;font-weight:700;cursor:pointer}.secondary{background:#fff;color:#15594e;border:1px solid #bbcfc8}.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:24px;margin-top:28px}.panel{padding:24px;border:1px solid #dedfd8;border-radius:8px;background:#fff;margin-top:20px}.split .panel{margin-top:0}.panel p:last-child{margin-bottom:0}.section{margin-top:40px}.list{list-style:none;padding:0;margin:0}.list li{padding:14px 0;border-bottom:1px solid #e2e4de}.list li:last-child{border-bottom:0}.pill{display:inline-block;font-size:.79rem;font-weight:700;padding:3px 9px;border-radius:20px;background:#e7eee7;color:#234e3f}.muted,small{color:#52616c}form{display:grid;gap:13px;margin:16px 0;max-width:720px}label{display:grid;gap:5px;font-weight:650}input,select,textarea{width:100%;padding:10px;border:1px solid #aebbbd;background:#fff;border-radius:4px;font:inherit;color:inherit}textarea{min-height:110px}button{justify-self:start}.notice{padding:14px 17px;border-left:4px solid #ac6d27;background:#f8ebd7}.check{display:flex;align-items:flex-start;gap:10px}.check input{width:auto;margin-top:6px}.foot{justify-content:flex-start;color:#e1e8ed;font-size:.9rem}.foot a{color:#fff;margin-left:auto}footer{background:#13253a}.abstract{max-width:760px;overflow-wrap:anywhere}@media(max-width:520px){nav{gap:12px}main{padding-top:28px}.panel{padding:17px}}`;

const badge = (paper) => `<span class="pill">${state[paper.status]}</span>`;
const button = (url,label,extra="") => `<a class="button ${extra}" href="${e(url)}"${url.startsWith("/signin-with-chatgpt?") ? ' target="_top"' : ''}>${e(label)}</a>`;
const input = (name,label,max=240,type="text",required=true) => `<label>${e(label)}<input name="${e(name)}" type="${type}" maxlength="${max}" ${required ? "required" : ""}></label>`;
const area = (name,label,max,required=true) => `<label>${e(label)}<textarea name="${name}" maxlength="${max}" ${required ? "required" : ""}></textarea></label>`;
const fileField = (label,manuscript=false) => `<label>${e(label)}<input type="file" name="${manuscript ? "manuscript" : "PDF"}" accept="${manuscript ? ".pdf,.docx" : "application/pdf,.pdf"}" required><small>${manuscript ? "PDF or Word (.docx)" : "PDF"}, up to 10 MB</small></label>`;
const form = (action,fields,label,upload=false) => `<form method="post" action="${action}" ${upload ? 'enctype="multipart/form-data"' : ""}>${fields}<button type="submit">${label}</button></form>`;
const options = (map) => Object.entries(map).map(([value,label]) => `<option value="${value}">${label}</option>`).join("");
const articleList = (papers) => papers.length ? `<ul class="list">${papers.map(p => `<li><div class="kicker">Open access � ${date(p.published)}</div><h3><a href="/articles/${p.id}">${e(p.title)}</a></h3><div>${e(p.authors)}</div></li>`).join("")}</ul>` : '<p class="muted">The journal archive is awaiting its first published article.</p>';
const paperList = (papers) => papers.length ? `<ul class="list">${papers.map(p => `<li>${badge(p)} <a href="/workspace/papers/${p.id}">${e(p.title)}</a><br><small>Submitted ${date(p.created)}</small></li>`).join("")}</ul>` : '<p class="muted">There are no manuscripts in this queue.</p>';

function siteContent(record) {
  return Object.fromEntries(Object.entries(SITE_FIELDS).map(([name,field]) => [name,record?.data[name] ?? field.initial]));
}

function siteDashboard(record, person, saved) {
  const content = siteContent(record);
  const fields = Object.entries(SITE_FIELDS).map(([name,{label,max,initial}]) => {
    if (name === "contact") return `<label>${e(label)}<input name="contact" type="email" maxlength="${max}" value="${e(content[name])}"></label>`;
    return `<label>${e(label)}<textarea name="${name}" maxlength="${max}" ${initial ? "required" : ""}>\n${e(content[name])}</textarea></label>`;
  }).join("");
  return shell("Owner dashboard",`<p><a href="/workspace">Journal workspace</a></p><div class="kicker">Site management</div><h1>Owner dashboard</h1>
  <p class="intro">Edit the public homepage and author guidelines. Saved changes appear immediately.</p>
  ${saved ? '<p class="notice" role="status">Website content saved.</p>' : ""}
  <section class="panel"><h2>Public website content</h2>${form(SITE_DASHBOARD,'<input type="hidden" name="version" value="' + e(record?.etag ?? "new") + '">' + fields,"Save website changes")}</section>
  <div class="actions">${button("/","View homepage","secondary")}${button("/guidelines","View author guidelines","secondary")}</div>`,person);
}

function guidelines(content) {
  const preparation = content.preparation === SITE_FIELDS.preparation.initial
    ? "<ol>" + content.preparation.split("\n").map(line => "<li>" + e(line.slice(3)) + "</li>").join("") + "</ol>"
    : "<p>" + para(content.preparation) + "</p>";
  const review = content.review.split(/\r?\n\r?\n/).map(paragraph => "<p>" + para(paragraph) + "</p>").join("");
  return `<div class="kicker">For authors</div><h1>Submission guidelines</h1><p class="intro">${para(content.scope)}</p>
  <div class="split"><section class="panel abstract"><h2>Prepare the submission</h2>${preparation}</section>
  <section class="panel abstract"><h2>Review and publication</h2>${review}</section></div>
  <div class="actions">${button("/submit","Submit a manuscript")}</div>`;
}

function article(paper, person, url) {
  const meta = [
    ["citation_title",paper.title],["citation_publication_date",date(paper.published).replaceAll("-","/")],
    ["citation_journal_title",NAME],["citation_pdf_url",url.origin + "/articles/" + paper.id + "/pdf"],
    ...paper.authors.split(";").map(a => ["citation_author",a.trim()])
  ].map(([k,v]) => `<meta name="${k}" content="${e(v)}">`).join("");
  return shell(paper.title,`<div class="kicker">Research archive � Open access</div><h1>${e(paper.title)}</h1><p>${e(paper.authors)}</p>
  <p class="muted">Published ${date(paper.published)}</p><div class="actions">${button("/articles/" + paper.id + "/pdf","Download PDF")}</div>
  <section class="section abstract"><h2>Abstract</h2><p>${para(paper.abstract)}</p></section>`,person,200,meta);
}

function detail(p, person, editor, assigned) {
  const route = "/workspace/papers/" + p.id;
  const author = p.owner === person.id;
  const round = p.assignments.filter(a => a.round === p.round);
  const manuscriptFormat = p.manuscript.endsWith(".docx") ? "Word (.docx)" : "PDF";
  let body = `<p><a href="/workspace"> Workspace</a></p><div class="kicker">Manuscript � Round ${p.round}</div><h1>${e(p.title)}</h1>${badge(p)}
  <section class="panel abstract"><h2>Abstract</h2><p>${para(p.abstract)}</p>${editor || author ? '<p><strong>Authors</strong> ' + e(p.authors) + '</p>' : ''}
  ${editor || author || (assigned && p.status === "reviewing") ? '<p><a href="' + route + '/manuscript">Download anonymized manuscript (' + manuscriptFormat + ')</a></p>' : ''}
  ${p.published ? '<p><a href="/articles/' + p.id + '">View published article</a></p>' : ''}</section>`;
  if (editor || author) {
    const decisions = p.decisions.toReversed().map(d => `<li><strong>${state[d.value]}</strong> � ${date(d.at)}<br>${para(d.note)}</li>`).join("");
    body += `<section class="panel"><h2>Editorial decisions</h2>${decisions ? '<ul class="list">' + decisions + '</ul>' : '<p>No editorial decision has been recorded.</p>'}</section>`;
  }
  if (author && p.status === "revision") body += `<section class="panel"><h2>Submit a revision</h2>${form(route + "/revise",fileField("Revised anonymized manuscript",true) + area("response","Response to the editor",6000),"Submit revision",true)}</section>`;
  if (editor) {
    if (p.response) body += `<section class="panel"><h2>Author response</h2><p>${para(p.response)}</p></section>`;
    body += `<section class="panel"><h2>Reviewer assignments</h2>${p.assignments.length ? '<ul class="list">' + p.assignments.map(a => {
      const emailBody = "You are invited to review an anonymized manuscript for " + NAME + ". Open " + p.origin + route + " and sign in with this email address to view the manuscript and submit your review.";
      const invite = "mailto:" + encodeURIComponent(a.email) + "?subject=" + encodeURIComponent("IJMAS peer review invitation") + "&body=" + encodeURIComponent(emailBody);
      return `<li><strong>${e(a.email)}</strong> � Round ${a.round} � ${a.review ? "Review received" : "Awaiting review"}
      ${a.round === p.round && p.status === "reviewing" && !a.review ? '<br><a href="' + e(invite) + '">Open invitation email</a>' : ''}
      ${a.review ? '<p><strong>' + recommendations[a.review.choice] + '</strong><br>' + para(a.review.report) + '</p>' : ''}</li>`;
    }).join("") + '</ul>' : '<p>No reviewers assigned.</p>'}
    ${["submitted","reviewing"].includes(p.status) ? form(route + "/assign",input("email","Reviewer email",254,"email"),"Assign reviewer") : ""}</section>`;
    if (["submitted","reviewing"].includes(p.status)) {
      body += `<section class="panel"><h2>Record an editorial decision</h2>${form(route + "/decide",'<label>Decision<select name="decision" required>' + options(round.some(a=>a.review) ? {revision:"Request revision",accepted:"Accept",rejected:"Decline"} : {rejected:"Decline"}) + '</select></label>' + area("note","Decision letter visible to the author",6000),"Record decision")}<small>Acceptance and revision requests require a completed review in the current round.</small></section>`;
    }
    if (p.status === "accepted") {
      body += `<section class="panel"><h2>Publish the article</h2><p>The title, author list, abstract, and final PDF will become public.</p>${form(route + "/publish",fileField("Final publication PDF") + '<label class="check"><input type="checkbox" name="confirm" value="yes" required> I confirm this is the approved PDF for public release.</label>',"Publish open access",true)}</section>`;
    }
  }
  if (assigned && !editor) {
    body += `<section class="panel"><h2>Your review</h2>${assigned.review ? '<p><strong>Submitted � ' + recommendations[assigned.review.choice] + '</strong></p><p>' + para(assigned.review.report) + '</p>' : p.status === "reviewing" ? form(route + "/review",'<label>Recommendation<select name="recommendation" required>' + options(recommendations) + '</select></label>' + area("report","Review report for the editor",12000),"Submit review") : '<p>This review round has closed.</p>'}</section>`;
  }
  return shell(p.title,body,person);
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const person = identity(request,env.AUTH_PROVIDER);
  const bucket = env.BUCKET;
  if (!["GET","HEAD","POST"].includes(request.method)) fail(405,"Method unavailable.");
  if (request.method === "POST") {
    if (request.headers.get("Origin") !== url.origin) fail(403,"Open the form directly from the journal website.");
    if (Number(request.headers.get("Content-Length")) > MAX + 50000) fail(413,"The file exceeds the upload limit.");
  }
  if (request.method !== "POST" && (path === "/" || path === "/guidelines")) {
    const content = siteContent(bucket ? await read(bucket,SITE_SETTINGS) : null);
    if (path === "/guidelines") return shell("Submission guidelines",guidelines(content),person);
    return shell("Home",`<section class="hero"><div class="kicker">Scholarly publishing � Open access</div><h1>${NAME}</h1><p>${para(content.introduction)}</p><div class="actions">${button("/articles","Explore articles")}${button("/submit","Submit a manuscript","secondary")}</div></section>
    ${content.announcement ? '<section class="panel abstract"><h2>Announcement</h2><p>' + para(content.announcement) + '</p></section>' : ""}
    ${content.contact ? '<section class="panel abstract"><h2>Contact the journal</h2><p><a href="mailto:' + encodeURIComponent(content.contact).replace("%40","@") + '">' + e(content.contact) + '</a></p></section>' : ""}
    <div class="split"><section class="panel"><div class="kicker">01 / Read</div><h2>Research archive</h2><p>Browse published articles and download their full-text PDFs.</p><p><a href="/articles">Visit the archive</a></p></section><section class="panel"><div class="kicker">02 / Contribute</div><h2>For authors</h2><p>Prepare an anonymized manuscript, submit it for consideration, and follow editorial decisions in your workspace.</p><p><a href="/guidelines">Read the guidelines</a></p></section><section class="panel"><div class="kicker">03 / Evaluate</div><h2>For reviewers and editors</h2><p>Access assigned manuscripts, submit peer reviews, or manage editorial decisions.</p><p><a href="/workspace">Open the workspace</a></p></section></div>`,person);
  }
  if (!bucket) fail(503,"Journal storage is temporarily unavailable.");
  if (request.method !== "POST" && path === "/articles") {
    const published = (await list(bucket,o => o.customMetadata?.status === "published")).filter(p => p.status === "published");
    published.sort((a,b) => b.published.localeCompare(a.published));
    return shell("Articles",`<div class="kicker">Open access</div><h1>Article archive</h1><section class="panel">${articleList(published)}</section>`,person);
  }
  const publicPath = /^\/articles\/([^/]+)(\/pdf)?$/.exec(path);
  if (request.method !== "POST" && publicPath && ID.test(publicPath[1])) {
    const record = await read(bucket,key(publicPath[1]));
    if (record?.data.status !== "published") fail(404,"Article not found.");
    const p = record.data;
    return publicPath[2] ? download(bucket,p.finalPdf,p.id,true) : article(p,person,url);
  }
  const privatePath = /^\/workspace\/papers\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
  if (!["/submit","/workspace","/workspace/setup",SITE_DASHBOARD].includes(path) && !privatePath) fail(404,"This page could not be found.");
  if (!person) {
    if (request.method === "POST") fail(401,"Sign in to use the journal workspace.");
    const github = env.AUTH_PROVIDER === "github";
    const provider = github ? "GitHub" : "ChatGPT";
    return shell("Journal sign-in",`<div class="kicker">Private workspace</div><h1>Sign in to IJMAS</h1><p class="intro">Use your ${provider} account to submit papers, view review assignments, and access editorial tools. ${github ? "Review invitations must match your verified primary GitHub email." : "Reviewers should use the email address on their invitation."}</p><div class="actions">${button(signIn(path,github),"Sign in with " + provider)}</div>`,null);
  }
  const chief = await read(bucket,"settings/editor.json");
  const editor = chief?.data.id === person.id;
  if (path === SITE_DASHBOARD) {
    if (!editor) fail(403,"Only the journal owner can manage the website.");
    const record = await read(bucket,SITE_SETTINGS);
    if (request.method !== "POST") return siteDashboard(record,person,url.searchParams.has("saved"));
    const data = await request.formData();
    if (data.get("version") !== (record?.etag ?? "new")) fail(409,"Website content changed in another session. Reopen the owner dashboard and try again.");
    const content = Object.fromEntries(Object.entries(SITE_FIELDS).map(([name,{max,initial}]) => [name,field(data,name,max,Boolean(initial))]));
    if (content.contact && !/^[^\s@<>]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(content.contact)) fail(400,"Enter a valid public contact email address.");
    const saved = await bucket.put(SITE_SETTINGS,JSON.stringify(content),{
      onlyIf:record ? {etagMatches:record.etag} : {etagDoesNotMatch:"*"}
    });
    if (!saved) fail(409,"Website content changed in another session. Reopen the owner dashboard and try again.");
    return redirect(SITE_DASHBOARD + "?saved=1");
  }
  if (path === "/workspace/setup") {
    if (chief) fail(403,"The editorial account has already been activated.");
    if (!env.EDITOR_SETUP_CODE) fail(503,"Editorial setup is temporarily unavailable.");
    if (request.method !== "POST") return shell("Editorial setup",`<h1>Activate the editorial account</h1><p>Activate from the account that will manage the journal.</p>${form(path,input("code","One-time activation code",128,"password"),"Activate editorial account")}`,person);
    const data = await request.formData();
    if (field(data,"code",128) !== env.EDITOR_SETUP_CODE) fail(403,"The activation code is invalid.");
    const activated = await bucket.put("settings/editor.json",JSON.stringify({id:person.id}),{onlyIf:{etagDoesNotMatch:"*"}});
    if (!activated) fail(409,"The editorial account has already been activated.");
    return redirect("/workspace");
  }
  if (path === "/submit") {
    if (request.method !== "POST") return shell("Submit a manuscript",`<div class="kicker">Author workspace</div><h1>Submit a manuscript</h1><p class="intro">Use an anonymized PDF or Word document. Enter author names separately in publication order, separated by semicolons.</p>
    <section class="panel">${form(path,input("title","Manuscript title") + input("authors","Author names",1000) + area("abstract","Abstract",6000) + fileField("Anonymized manuscript",true) + '<label class="check"><input type="checkbox" name="anonymous" value="yes" required> I removed identifying information from the manuscript and its file metadata.</label>',"Submit manuscript",true)}</section>`,person);
    const data = await request.formData();
    if (data.get("anonymous") !== "yes") fail(400,"Confirm that the manuscript is anonymized.");
    const p = {id:crypto.randomUUID(),origin:url.origin,owner:person.id,ownerEmail:person.email,title:field(data,"title",240),authors:field(data,"authors",1000),abstract:field(data,"abstract",6000),created:now(),status:"submitted",round:1,assignments:[],decisions:[]};
    await replaceFile(bucket,p,data,"manuscript");
    return redirect("/workspace/papers/" + p.id);
  }
  if (request.method !== "POST" && path === "/workspace") {
    const papers = await list(bucket,() => true);
    const mine = papers.filter(p=>p.owner === person.id);
    const assigned = papers.filter(p=>p.assignments.some(a=>a.email === person.email && a.round === p.round));
    return shell("Workspace",`<div class="kicker">IJMAS � Private workspace</div><h1>Journal workspace</h1><p class="muted">Signed in as ${e(person.email)}</p>
    <div class="actions">${button("/submit","New submission")}${editor ? button(SITE_DASHBOARD,"Owner dashboard","secondary") : ""}</div><div class="split"><section class="panel"><h2>My submissions</h2>${paperList(mine)}</section><section class="panel"><h2>My review assignments</h2>${paperList(assigned)}</section></div>
    ${editor ? '<section class="panel"><h2>Editorial queue</h2>' + paperList(papers) + '</section>' : ""}`,person);
  }
  if (!privatePath || !ID.test(privatePath[1])) fail(404,"Manuscript not found.");
  const record = await read(bucket,key(privatePath[1]));
  if (!record) fail(404,"Manuscript not found.");
  const {data:p,etag} = record;
  const author = p.owner === person.id;
  const assigned = p.assignments.find(a=>a.email === person.email && a.round === p.round);
  if (!editor && !author && !assigned) fail(404,"Manuscript not found.");
  const action = privatePath[2];
  const route = "/workspace/papers/" + p.id;
  if (request.method !== "POST") {
    if (!action) return detail(p,person,editor,assigned);
    if ((action === "manuscript" || (action === "pdf" && p.manuscript.endsWith(".pdf"))) &&
        (editor || author || (assigned && p.status === "reviewing"))) return download(bucket,p.manuscript,p.id,false);
    fail(404,"File or page not found.");
  }
  const data = await request.formData();
  if (action === "review" && assigned && !editor && !author && p.status === "reviewing" && !assigned.review) {
    const choice = field(data,"recommendation",30);
    if (!Object.hasOwn(recommendations,choice)) fail(400,"Choose a valid recommendation.");
    assigned.review = {choice,report:field(data,"report",12000),at:now()};
  } else if (action === "revise" && author && p.status === "revision") {
    p.round++;
    p.response = field(data,"response",6000);
    p.status = "submitted";
    await replaceFile(bucket,p,data,"manuscript",etag);
    return redirect(route);
  } else if (action === "assign" && editor && ["submitted","reviewing"].includes(p.status)) {
    const email = field(data,"email",254).toLowerCase();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || email === p.ownerEmail || email === person.email) fail(400,"Enter an eligible reviewer email address.");
    if (p.assignments.some(a=>a.email === email && a.round === p.round)) fail(409,"This reviewer is already assigned to this round.");
    p.assignments.push({email,round:p.round,at:now()});
    p.status = "reviewing";
  } else if (action === "decide" && editor && ["submitted","reviewing"].includes(p.status)) {
    const value = field(data,"decision",30);
    if (!["accepted","revision","rejected"].includes(value)) fail(400,"Choose a valid decision.");
    if (value !== "rejected" && !p.assignments.some(a=>a.round === p.round && a.review)) fail(409,"A completed review is required in this round.");
    p.decisions.push({value,note:field(data,"note",6000),at:now()});
    p.status = value;
  } else if (action === "publish" && editor && p.status === "accepted") {
    if (data.get("confirm") !== "yes") fail(400,"Confirm that the final PDF is approved for public release.");
    p.status = "published";
    p.published = now();
    await replaceFile(bucket,p,data,"finalPdf",etag);
    return redirect("/articles/" + p.id);
  } else {
    fail(403,"This action is unavailable for your role or the current manuscript status.");
  }
  await write(bucket,p,etag);
  return redirect(route);
}

export default { async fetch(request, env) {
  try {
    const response = await handle(request,env);
    return request.method === "HEAD" ? new Response(null,{status:response.status,headers:response.headers}) : response;
  } catch (error) {
    if (!error.status) console.error("Journal request failed",error.name);
    return shell("Journal notice",`<h1>${error.status === 404 ? "Page unavailable" : "Journal notice"}</h1><p>${e(error.status ? error.message : "The journal could not complete this request. Try again shortly.")}</p><p><a href="/workspace">Return to the workspace</a></p>`,identity(request,env.AUTH_PROVIDER),error.status || 500);
  }
} };
