/**
 * The consent + login screen shown during the OAuth authorization step.
 *
 * Self-contained HTML: no external stylesheets, fonts, or scripts, so it works
 * behind a strict CSP and cannot leak the form to a third party.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface LoginPageOptions {
  txn: string;
  clientName: string;
  environmentLabel: string;
  defaultDomain?: string;
  error?: string;
}

export function renderLoginPage(options: LoginPageOptions): string {
  const { txn, clientName, environmentLabel, defaultDomain, error } = options;

  const errorBlock = error
    ? `<p class="error" role="alert">${escapeHtml(error)}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to MeraMonitor</title>
<style>
  :root { color-scheme: light dark; --bg:#f4f5f7; --card:#fff; --fg:#1a1d21; --muted:#5c6672;
          --line:#d8dde3; --accent:#2b6cb0; --err:#b42318; --errbg:#fef3f2; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#15181c; --card:#1d2126; --fg:#e8eaed; --muted:#9aa4b0;
            --line:#333a42; --accent:#63a4e8; --err:#f97066; --errbg:#2d1b1a; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:var(--bg); color:var(--fg); padding:24px;
         font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px;
          padding:32px; width:100%; max-width:400px; }
  h1 { margin:0 0 4px; font-size:19px; }
  .sub { margin:0 0 24px; color:var(--muted); font-size:13.5px; }
  .env { display:inline-block; margin-left:6px; padding:1px 7px; border-radius:20px;
         background:var(--accent); color:#fff; font-size:11px; font-weight:600;
         text-transform:uppercase; letter-spacing:.03em; vertical-align:1px; }
  label { display:block; margin:0 0 6px; font-size:13px; font-weight:600; }
  input { width:100%; padding:10px 12px; margin-bottom:16px; font-size:15px;
          border:1px solid var(--line); border-radius:7px; background:var(--bg); color:var(--fg); }
  input:focus { outline:2px solid var(--accent); outline-offset:-1px; border-color:transparent; }
  button { width:100%; padding:11px; font-size:15px; font-weight:600; cursor:pointer;
           border:0; border-radius:7px; background:var(--accent); color:#fff; }
  button:hover { filter:brightness(1.08); }
  .error { margin:0 0 16px; padding:10px 12px; border-radius:7px;
           background:var(--errbg); color:var(--err); font-size:13.5px; }
  .foot { margin:20px 0 0; color:var(--muted); font-size:12px; text-align:center; }
</style>
</head>
<body>
  <main class="card">
    <h1>Sign in to MeraMonitor<span class="env">${escapeHtml(environmentLabel)}</span></h1>
    <p class="sub">${escapeHtml(clientName)} is requesting access to your MeraMonitor data.
       You will be acting as yourself, with your existing role and permissions.</p>
    ${errorBlock}
    <form method="post" action="/login" autocomplete="on">
      <input type="hidden" name="txn" value="${escapeHtml(txn)}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="username" autofocus>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required autocomplete="current-password">
      <label for="domain">Domain</label>
      <input id="domain" name="domain" type="text" required value="${escapeHtml(defaultDomain ?? '')}">
      <button type="submit">Sign in and authorize</button>
    </form>
    <p class="foot">Your password is used once to sign in and is never stored.</p>
  </main>
</body>
</html>`;
}

export function renderErrorPage(title: string, detail: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         padding:24px; font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .card { max-width:420px; }
  h1 { font-size:18px; margin:0 0 8px; }
  p { color:#5c6672; margin:0; }
</style>
</head>
<body><main class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body>
</html>`;
}
