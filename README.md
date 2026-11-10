# International Journal of Management and Administration Studies

The site has a public article archive and a private workspace for authors, assigned reviewers, and the editor.

## Editorial workflow

1. The author signs in with ChatGPT and uploads an anonymized PDF or Word (.docx) manuscript of up to 10 MB. Author names and the abstract are entered separately.
2. The editor assigns reviewers by email. The invitation link opens the editor's email client with a draft. The editor sends the invitation there. Reviewers sign in with the assigned address to download the anonymized manuscript in its submitted format.
3. Reviewers submit a recommendation and report. The editor records a decision letter visible to the author. An editor can decline a submission before review. Acceptance and revision requests require a completed review in the current round.
4. An author asked to revise uploads a revised anonymized PDF or Word manuscript and a response. The editor assigns reviewers for the new round.
5. For an accepted paper, the editor uploads a final PDF and confirms public release. The article page displays the title, author list, abstract, publication date, and PDF download. Readers can open the page and download the PDF anonymously after the Site has public access.

## Build and verify

Use Node.js 22 or later. From this directory, run:

```powershell
node test-journal.mjs
node build.mjs
```

The test uses a simulated bucket and signed-in identities. It checks the editorial workflow and role boundaries without contacting reviewers or creating live articles.

## Hosting

The Cloudflare Worker entry point builds to `dist/server/index.js`. A deployment must bind a private R2 bucket as `BUCKET`. The GitHub repository contains the source. The journal requires a server runtime for sign-in, manuscript storage, reviewer access, and publication. The site depends on Sites-managed ChatGPT authentication. A direct Worker deployment must provide a trusted authentication gateway that strips incoming identity headers and injects verified identities.

Configure a random `EDITOR_SETUP_CODE` as a secret in the site's runtime. The journal administrator signs in and enters that code at `/workspace/setup`. A successful activation binds the editorial role to that signed-in account. Remove the setup secret after activation. Before accepting live manuscripts, verify the editor, author, and reviewer sign-in paths and public PDF access with separate test accounts.
