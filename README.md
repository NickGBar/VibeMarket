# VibeMarket

**English** · [Русский](README.ru.md)

An autonomous market for free, open-source apps. No ads, banners or trackers. Part of OpenCraft Hub.

Live site: https://nickgbar.github.io/VibeMarket/

The market runs without a server and without day-to-day moderators. The site is hosted on GitHub Pages. Developers submit apps through GitHub, the community votes with reactions, and a robot in GitHub Actions publishes, promotes and removes apps by the rules in `rules.json`.

## What's inside

| File | What it is |
| --- | --- |
| `index.html` | The whole market page, no build step and no dependencies. Russian is built into it |
| `locales/` | Site translations into English, Spanish and Chinese |
| `catalog.json` | Data from the robot: stars, download files, sandbox, voting, hidden apps |
| `rules.json` | The rules the robot follows |
| `scripts/robot.mjs` | The robot |
| `scripts/robot-i18n.mjs` | Robot replies and form field labels in every language |
| `scripts/downloads.mjs` | Sorts release files by system and processor for the Get button |
| `scripts/scout.mjs` | The scout: finds new open-source apps on GitHub every week |
| `scripts/build-site.mjs` | Builds the site for GitHub Pages: a page for every app in four languages and `sitemap.xml` |
| `scripts/github.mjs` | GitHub API requests shared by the robot and the scout |
| `scripts/mcp.mjs` | MCP server for AI agents, see below |
| `scripts/check-locales.mjs` | Checks translations against the Russian source |
| `.github/workflows/robot.yml` | Runs the robot and publishes the site |
| `.github/workflows/scout.yml` | Runs the scout once a week |
| `test/robot/` | Robot and scout tests against a fake GitHub API |
| `test/mcp/` | MCP server tests |
| `.github/ISSUE_TEMPLATE/` | Submission and report forms in four languages |
| `server.mjs` | Optional server for signing in with GitHub, see below |

## How an app gets into the market

1. The author adds the `vibemarket` topic to their repository and publishes a release. Only people with rights to a repository can set its topics, so nobody can submit someone else's project.
2. In the Sandbox section the author clicks «Submit an app» and fills in the form. It opens an already filled-in submission on GitHub in the site's language; the author ticks three confirmations and submits it.
3. The robot checks the submission within a few minutes and replies with a comment in the language of the form. If something is wrong, the author edits the submission and the robot checks it again.
4. The community votes 👍 or 👎 on the submission. Voting lasts 7 days, and while it's open the submission is shown on the site's «Voting now» shelf.
5. If there are enough votes, the robot adds the app to the sandbox, closes the submission and republishes the site.
6. After 90 days, an app with 500 stars and no reports is moved to its regular category on the main page. It keeps its «Third-party» badge.

All numbers come from `rules.json`.

## Rules

| Key | Meaning | Current value |
| --- | --- | --- |
| `repo.minAgeDays` | Minimum repository age, days | 30 |
| `repo.requireRelease` | At least one release is required | yes |
| `repo.requireTopic` | Topic that proves rights to the repository | `vibemarket` |
| `repo.allowForks` | Accept forks | no |
| `repo.licenses` | Allowed licenses (SPDX) | MIT, Apache-2.0, GPL and other open licenses |
| `voting.days` | Voting period, days | 7 |
| `voting.votesNeeded` | 👍 needed. 👍 − weight×👎 must also be at least this number | 10 |
| `voting.downvoteWeight` | Weight of one 👎 | 2 |
| `voting.voterMinAgeDays` | Minimum voter account age, days | 90 |
| `promotion.minDays`, `promotion.minStars` | When to move an app to the main page | 90 days, 500 stars |
| `reports.toHide` | Reports from different accounts that hide an app | 3 |
| `limits.candidatesPerAuthor` | Submissions one author can have in voting at the same time | 3 |
| `scout.topics` | GitHub topics the scout searches | `desktop-app`, `electron-app`, `tauri-app` and others |
| `scout.minStars` | Minimum stars for a find | 1000 |
| `scout.releaseWithinDays` | The latest release must be no older than this, days | 365 |
| `scout.perRun` | Finds per run | 5 |
| `scout.skip` | Repositories the scout never suggests | none |

Votes from the submission author, from accounts younger than the threshold, votes cast before voting started, and a 👍 together with a 👎 from the same person don't count. If the author changes the repository in the submission, voting starts over.

## Reports and the emergency stop

- **Reports.** Every app page has a «Report this app» link. It opens the report form in the site's language with the repository already filled in. Once an app collects `reports.toHide` open reports from different accounts older than 90 days, the robot hides it from all shelves, search and pages. As soon as a maintainer closes the reports, the app comes back on its own.
- **The `blocked` label.** Put it on an app's submission and the robot removes the app on its next run. Only people with rights to the market repository can set labels. To bring the app back, the author reopens the submission and it goes through voting again.
- **Daily re-check.** Once a day the robot re-checks published apps. If a repository is deleted, made private, archived or switches to a non-open license, the app is removed and the submission gets a comment explaining why.

## Downloads

The Get button downloads the app with one click, straight from the project's GitHub releases.

1. **The robot sorts the files.** Every hour it reads the latest releases of every app and sorts the files by name (`scripts/downloads.mjs`). The extension gives the system: `.dmg` is macOS, `.msi` and `.exe` are Windows, `.AppImage` and `.deb` are Linux, `.apk` is Android. Words in the name give the processor: `arm64` and `aarch64`, `x64` and `x86_64`, `universal`. Checksums, signatures, server and command-line builds are dropped. Installers come before archives. The result goes to `catalog.json` with the size and SHA-256 of every file.
2. **The page picks a file.** The browser reports the system, and Chrome and Edge also report the processor. Safari and Firefox don't, so a Mac gets the universal or Apple Silicon build with an Intel link next to it, and Windows gets x64.
3. **The button says what it will do.** «Get» downloads the file. «Open» opens the web version. «Website» and «GitHub» lead to the project's download page when its releases have no ready-made files. The app page lists every file by system with its size and SHA-256.

`downloads.skip` in `rules.json` lists repositories whose release files aren't the app itself, such as a framework's command-line tool. `downloads.tags` keeps only matching releases when a repository publishes several products. Links to official download pages and web versions are in `LINKS` in `index.html`.

## Scout: new apps for the catalog

Once a week the scout (`scripts/scout.mjs`) searches GitHub for free open-source apps that aren't in the catalog yet. A find must:
- have one of the topics from `scout.topics` and at least `scout.minStars` stars;
- have an open license from `repo.licenses`;
- have a release no older than `scout.releaseWithinDays` days;
- have ready-made files for the Get button, found by the same release sorting the button uses.

For every find the scout opens an issue labeled `scout` with the card fields already filled in. It builds the name from the repository name and guesses the category from its topics and description.

1. **Check the fields.** Edit them right in the issue description if needed.
2. **Add the `approved` label.** On its next run the robot adds the app to its category on the main page, comments with a link to its page and closes the issue. Approved finds have no «Third-party» badge: the maintainer picked them.
3. **Or close the issue** if the app doesn't fit. The scout won't suggest it again.

An approved find is removed with the `blocked` label, and the daily re-check applies to it just like to sandbox apps. You can also add an app by hand: open an issue with the same fields and add the `scout` and `approved` labels.

## Pages for search engines

The site is one page, but on GitHub Pages every app also gets its own address in every language, such as `en/app/zed/` or `ru/app/zed/`. `scripts/build-site.mjs` builds them on every deploy. Each page has its own title and description, `hreflang` links to the other languages, schema.org markup and the app's text, so a search engine sees it even without JavaScript. The script on the page then turns it into the regular interface. Links inside the site lead to these addresses. The root address picks the visitor's language. Old links like `#app-zed` still work.

`index.html` in the repository stays a single file. Without the build (local file, `server.mjs`, previews) apps open at `#app-zed` as before.

To get the site indexed faster, add it to Google Search Console and Yandex Webmaster and submit `sitemap.xml`. To verify the site, put the verification HTML file (`google….html`, `yandex_….html`) in the root of the repository and the build copies it to the root of the site. Or put the meta tag codes into the repository variables `GOOGLE_SITE_VERIFICATION` and `YANDEX_VERIFICATION` (**Settings → Secrets and variables → Actions → Variables**), and the build adds them to the home page. Search engines only read `robots.txt` at the root of the domain, so a project site doesn't have one: submit the sitemap by hand.

## For AI agents (MCP)

VibeMarket has its own MCP server, `scripts/mcp.mjs`. An AI agent such as Claude Code, Claude Desktop or Cursor can use it to search the catalog, find free replacements for paid products and download the right installer for the computer it runs on.

Claude Code:

```
claude mcp add vibemarket -- npx -y github:NickGBar/VibeMarket
```

Claude Desktop, Cursor and other clients, in the `mcpServers` section of their settings:

```json
{ "mcpServers": { "vibemarket": { "command": "npx", "args": ["-y", "github:NickGBar/VibeMarket"] } } }
```

| Tool | What it does |
|---|---|
| `find_alternative` | Free replacements for a product: «Notion», «Photoshop», «Slack» |
| `search_apps` | Search by keywords, category, platform or collection |
| `get_app` | Description, platforms, license, links, and files with sizes and SHA-256 |
| `recent_updates` | Apps with new releases |
| `list_collections` | The «Instead of …» collections and the categories |
| `download_app` | Downloads the installer for this computer from the app's GitHub release and checks its SHA-256 |

The server runs on your computer, has no dependencies and needs Node.js 22.9 or newer. It reads `apps.json` from the site: the whole catalog in machine-readable form, which anyone can use. `download_app` saves files to the Downloads folder, never overwrites existing files, only accepts links to the app's own GitHub releases and never runs installers: the user installs the app.

## Languages

The site, the GitHub forms and the robot's replies are available in Russian, English, Spanish and Chinese.

**The site.** The language switcher is in the header, and the choice is remembered in the browser. On the first visit the language comes from the browser settings; if it isn't one of these four, the site opens in English.

- Russian is built into `index.html`: interface strings are in the `<script type="application/json" id="i18n-ru">` block, catalog texts are in the `CATS`, `APPS` and `DETAILS` data. That's why the page opens instantly and works even as a plain file.
- The other languages live in `locales/en.json`, `locales/es.json` and `locales/zh.json`, and the page loads them when selected. Each file has a `ui` section with the same keys as the Russian block, `cats` with categories, and `apps` with descriptions, full texts and screenshot captions for every app in the catalog.
- Plural forms are objects keyed by `Intl.PluralRules` categories: `one` and `other` for English, plus `many` for Spanish, and just `other` for Chinese.
- Translations are inserted into the page as is, so HTML is not allowed in them.

**GitHub forms.** Each form has a version in every language: `submit-app.yml` (Russian), `submit-app-en.yml`, `submit-app-es.yml`, `submit-app-zh.yml`, and the same for `report-app*.yml`. The site opens the version in the visitor's language. Fields have the same ids in every version, and category, color and platforms are accepted both as ids (`work`, `green`, `web`) and as names in any of the four languages.

**The robot** detects the submission's language from the field labels and replies in it. Its texts and the form labels are in `scripts/robot-i18n.mjs`.

Only sandbox app texts are not translated: their authors write them.

Check the site translations against the Russian source:

```bash
npm run locales
```

The script reports missing and extra keys, wrong `{name}`-style variables, missing plural forms, missing app texts and HTML in translations. In GitHub Actions it runs before every deployment and prints warnings without blocking the deployment.

To add a language:

1. Copy `locales/en.json` to `locales/<code>.json` and translate it. Add the code to `LANGS` and to the `<select id="lang">` list in `index.html`.
2. Add `submit-app-<code>.yml` and `report-app-<code>.yml` forms.
3. Add the field labels to `FORM_LABELS` and the robot texts to `MESSAGES` in `scripts/robot-i18n.mjs`.

## What the robot can't do

- Check an app's security: malicious code with a good license passes every rule. That's why the site shows a warning, and the `blocked` label exists for emergencies.
- Check that an app is really free: the author confirms that.
- Fully protect voting from account farms: the account age threshold makes manipulation harder but doesn't rule it out.

Legally, the owner of the repository is responsible for the market's content. Automation doesn't change that.

## Running on GitHub

One-time setup:

1. Push the code to the repository's `main` branch.
2. Open **Settings → Pages** in the repository and set **Source** to **GitHub Actions**.
3. Open **Actions → Робот VibeMarket → Run workflow**, or wait for the next scheduled run.

The robot runs every hour, on every Issues event, on every push to `main`, and manually. Runs are queued one at a time. If a run drops out of the queue, the next scheduled run catches up: the robot re-reads all open submissions every time.

GitHub disables schedules in public repositories after 60 days without activity. The robot commits `catalog.json` whenever star counts change, so a live catalog always has activity.

The scout runs on Mondays and manually: **Actions → Разведчик VibeMarket → Run workflow**.

### Robot security

- The robot reads submission texts through the API and never passes them to a shell. The only thing the shell runs is `scripts/robot.mjs` from the `main` branch.
- Catalog entries are built from validated fields, never copied from the author's files. The robot never runs code from submitted repositories.
- Voting metadata is kept in the robot's own comment, and the robot only trusts comments by `github-actions[bot]`, so nobody can fake when voting started.
- Workflows have minimal permissions, and third-party actions are pinned to commit hashes.
- The page escapes all data from `catalog.json` as untrusted, and accepts download links only to the releases of the same repository on github.com.
- Repository descriptions the scout puts into issues are untrusted too. They go in as a single line, without HTML comments and without @mentions, so nobody can slip in extra form fields or fake the scout's marker.

## Local development

- Open `index.html` in a browser: the page works without a server, using the catalog snapshot built into it.
- `GH_TOKEN=$(gh auth token) npm run robot`: a full robot run without writing to GitHub. Only `catalog.json` on disk changes.
- `npm run stars`: update the star snapshot built into `index.html`. It's used when `catalog.json` is unavailable.
- `npm run locales`: check translations against the Russian source.
- `npm test`: robot, scout and MCP server tests against a fake GitHub API, no network needed.
- `npm run mcp`: start the MCP server from the repository, for example to connect a local copy to an agent.
- `GH_TOKEN=$(gh auth token) npm run scout`: show what the scout would find right now, without opening issues.
- `npm run site`: build the site into `_site/` the way GitHub Pages gets it.

## Optional server: signing in with GitHub

The market doesn't need a server. But if you run `server.mjs`, the site gets:

- signing in with GitHub, with an avatar and username in the header;
- a Star button on app pages that stars and unstars the project right on GitHub;
- a «Your stars» shelf and badges on cards;
- star counts refreshed through the GitHub API on the user's behalf.

No dependencies, Node.js 22.9 or newer is required.

```bash
npm start
```

### Setup

1. Create a GitHub App: https://github.com/settings/apps/new
   - **Homepage URL**: `http://localhost:3000`.
   - **Callback URL**: `http://localhost:3000/auth/callback`.
   - **Webhook**: uncheck **Active**.
   - **Permissions → Account permissions → Starring**: `Read and write`. No other permissions are needed.
   - **Where can this GitHub App be installed?** `Only on this account` to try it yourself, `Any account` so other people can sign in.
2. Copy the **Client ID** and generate a **client secret**.
3. Create `.env` from the example and paste both values into it:

   ```bash
   cp .env.example .env
   ```

A GitHub App is used instead of an OAuth App because an OAuth App would need write access to all of the user's public repositories (`public_repo`) just to star projects.

How the server works:

- The GitHub token lives only in server memory; the browser gets a session cookie with `HttpOnly` and `SameSite=Lax`. Sign-in is protected with `state` and PKCE, and the token is revoked on sign-out.
- The page still doesn't contact third-party sites, except the GitHub API in the submission form. The CSP allows only the page's own script to run.
- Only apps from the catalog and the sandbox can be starred.
- Sessions are kept in memory, so you need to sign in again after a restart.
- Your own domain needs HTTPS. Set `BASE_URL=https://your-domain` and update the URLs in the GitHub App settings.

## License

VibeMarket's code and texts are released under the [MIT License](LICENSE). Apps in the catalog and the sandbox belong to their authors and are distributed under their own licenses, which are shown on their cards.
