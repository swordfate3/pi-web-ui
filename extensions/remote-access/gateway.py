#!/usr/bin/env python3
"""Standalone Linux/Caddy account maintenance. Never execute through a web request.

Supports one dedicated site file with one direct basic_auth block. Complex shared
files, matchers and imported auth are deliberately refused rather than rewritten.
The main config can import this site; other site files are never edited.
"""
import argparse
import base64
import datetime
import fcntl
import getpass
import json
import os
import pathlib
import re
import ssl
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

PLAN = None  # Replaced with a validated nonsecret plan in downloaded materials.
UNSPECIFIED = object()


def safe_user(value):
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@-]{0,63}", value):
        raise ValueError("Use a plain login username (1-64 characters)")
    return value


def update_account(text, domain, old_user, new_user, password_hash, keep_old=False):
    safe_user(old_user)
    safe_user(new_user)
    if not re.fullmatch(r"\$2[aby]\$\d{2}\$[A-Za-z0-9./]+", password_hash):
        raise ValueError("Caddy did not return a bcrypt hash")
    lines = text.splitlines(keepends=True)
    meaningful = [(i, line.split("#", 1)[0].strip()) for i, line in enumerate(lines) if line.split("#", 1)[0].strip()]
    if not meaningful or meaningful[0][1] != domain + " {" or meaningful[-1][1] != "}":
        raise ValueError("Expected a dedicated file for exactly the selected domain")
    depth = 0
    auth_start = None
    auth_end = None
    in_auth = False
    for i, line in meaningful:
        if "import " in line or '"' in line or "\\" in line:
            raise ValueError("Imported/quoted configs require manual review")
        if line.endswith(" {"):
            if line.startswith(("basic_auth", "basicauth")):
                if depth != 1 or auth_start is not None or line not in ("basic_auth {", "basicauth {"):
                    raise ValueError("Only one direct, unscoped basic_auth block is supported")
                auth_start, in_auth = i, True
            depth += 1
        elif line == "}":
            depth -= 1
            if in_auth:
                auth_end, in_auth = i, False
            if depth == 0 and i != meaningful[-1][0]:
                raise ValueError("Multiple sites are not supported in the edited file")
            if depth < 0:
                raise ValueError("Unbalanced site config")
        elif "{" in line or "}" in line:
            raise ValueError("Inline blocks/placeholders require manual review")
    if depth != 0 or auth_start is None or auth_end is None:
        raise ValueError("Missing/unbalanced basic_auth block")
    accounts = {}
    for i in range(auth_start + 1, auth_end):
        line = lines[i].split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) != 2 or parts[0] in accounts:
            raise ValueError("Unsupported authentication syntax")
        safe_user(parts[0])
        accounts[parts[0]] = i
    if old_user not in accounts:
        raise ValueError("Selected old account was not found; nothing changed")
    if new_user != old_user and new_user in accounts:
        raise ValueError("New username already exists; nothing changed")
    index = accounts[old_user]
    indent = re.match(r"\s*", lines[index]).group()
    replacement = f"{indent}{new_user} {password_hash}\n"
    lines[index] = lines[index] + replacement if keep_old and new_user != old_user else replacement
    return "".join(lines)


def atomic_write(target, text, previous_stat=None):
    fd, filename = tempfile.mkstemp(prefix=".pi-web-", dir=target.parent)
    try:
        os.fchmod(fd, previous_stat.st_mode & 0o777 if previous_stat else 0o640)
        if previous_stat and os.geteuid() == 0:
            os.fchown(fd, previous_stat.st_uid, previous_stat.st_gid)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(filename, target)
    finally:
        if os.path.exists(filename):
            os.unlink(filename)


def apply_config(site_file, candidate, validate, reload, expected_original=UNSPECIFIED):
    target = pathlib.Path(site_file)
    if target.is_symlink():
        raise ValueError("Symlink site files are not supported")
    previous = target.read_text() if target.exists() else None
    if expected_original is not UNSPECIFIED and previous != expected_original:
        raise ValueError("Site changed during maintenance; no changes applied")
    previous_stat = target.stat() if target.exists() else None
    backup = None
    if previous is not None:
        suffix = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        backup = target.with_name(target.name + ".backup-" + suffix)
        # Private backup, with no *.caddy suffix (do not match import *.caddy).
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(previous)
    atomic_write(target, candidate, previous_stat)
    reload_attempted = False
    try:
        validate()
        if target.is_symlink() or target.read_text() != candidate:
            raise ValueError("Site changed during validation; administrator must inspect Caddy")
        reload_attempted = True
        reload()
    except BaseException:
        if target.is_symlink() or not target.exists() or target.read_text() != candidate:
            raise RuntimeError("Concurrent site change detected; refusing to overwrite it. Administrator must inspect disk and active Caddy config")
        if previous is None:
            target.unlink()
        else:
            atomic_write(target, previous, previous_stat)
        if reload_attempted:
            try:
                reload()
            except BaseException as rollback_error:
                raise RuntimeError("Disk restored, but rollback reload failed; administrator must inspect Caddy") from rollback_error
        raise
    return backup


def new_site(domain, username, password_hash, upstream_port):
    safe_user(username)
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", domain):
        raise ValueError("Use a plain domain")
    if not re.fullmatch(r"\$2[aby]\$\d{2}\$[A-Za-z0-9./]+", password_hash):
        raise ValueError("Invalid Caddy hash")
    if not 1 <= upstream_port <= 65535:
        raise ValueError("Invalid loopback upstream port")
    # Browsers can attach cached Basic auth to cross-site WebSocket requests.
    # Reject ALL foreign Origin headers; non-browser CLI requests need no Origin.
    return (f"{domain} {{\n"
            "    @foreignOrigin {\n        header Origin *\n"
            f"        not header Origin https://{domain}\n    }}\n"
            "    respond @foreignOrigin 403\n    basic_auth {\n"
            f"        {username} {password_hash}\n    }}\n"
            f"    reverse_proxy 127.0.0.1:{upstream_port}\n}}\n")


def check_effective_config(config, domain, username, password_hash, require_origin_guard=False):
    """Prove the FULL Caddyfile includes this site's unscoped auth before reload.

    Deliberately fail closed for merged/complex routes rather than inferring that
    merely validating an unrelated main config has applied the selected account.
    """
    sites = []
    for server in config.get("apps", {}).get("http", {}).get("servers", {}).values():
        routes = server.get("routes", [])
        for index, route in enumerate(routes):
            if route.get("match") == [{"host": [domain]}]:
                # An earlier catch-all or complex matcher may bypass this site.
                for earlier in routes[:index]:
                    matches = earlier.get("match", [])
                    if not matches or any(set(match) != {"host"} or not match["host"] or any(host == domain or "*" in host for host in match["host"]) for match in matches):
                        raise ValueError("Earlier shared routes require manual authentication review")
                sites.append((server, route))
    if len(sites) != 1:
        raise ValueError("Full config must include exactly one dedicated route for the selected domain")
    selected_server, site = sites[0]
    # Failed basic_auth returns a handler error. An error route can proxy the
    # same unauthenticated request without revisiting the normal auth/Origin
    # chain, so even a valid dedicated site needs the server's errors checked.
    if selected_server.get("errors", {}).get("routes"):
        raise ValueError("Selected server error routes require manual authentication review")
    # Binding creates independent HTTP servers. A protected loopback route says
    # nothing about a public listener's catch-all, wildcard or complex matcher.
    # Without a verified DNS/listener map, require disjoint plain hosts on ALL
    # other servers, even on another port; never infer public endpoint safety.
    for server in config.get("apps", {}).get("http", {}).get("servers", {}).values():
        if server is selected_server:
            continue
        for route in server.get("routes", []):
            matches = route.get("match", [])
            if not matches or any(set(match) != {"host"} or not match["host"] or any(host == domain or "*" in host for host in match["host"]) for match in matches):
                raise ValueError("Other listeners may serve the selected domain; disjoint plain hosts or manual authentication review are required")
    handlers = site.get("handle", [])
    if set(site) != {"match", "handle", "terminal"} or site["terminal"] is not True or len(handlers) != 1 or set(handlers[0]) != {"handler", "routes"} or handlers[0]["handler"] != "subroute":
        raise ValueError("Only a dedicated terminal site with simple ordered handlers is supported")
    routes = handlers[0]["routes"]
    authenticated, guarded, proxied = False, False, False
    foreign_origin = [{"header": {"Origin": ["*"]}, "not": [{"header": {"Origin": [f"https://{domain}"]}}]}]
    for index, route in enumerate(routes):
        chain = route.get("handle", [])
        if set(route) - {"handle", "match"} or len(chain) != 1:
            raise ValueError("Nested, terminal or alternative handler chains require manual review")
        handler = chain[0]
        kind = handler.get("handler")
        if kind == "static_response" and route.get("match") == foreign_origin and handler == {"handler": "static_response", "status_code": 403} and not guarded and not proxied:
            guarded = True
        elif kind == "authentication" and not route.get("match") and not authenticated and not proxied:
            providers = handler.get("providers", {})
            accounts = providers.get("http_basic", {}).get("accounts", [])
            if set(providers) != {"http_basic"} or not any(account.get("username") == username and account.get("password") == password_hash for account in accounts):
                raise ValueError("Full config does not include the selected site's new account/hash; check the import and container directory mount")
            authenticated = True
        elif kind == "reverse_proxy" and not route.get("match") and authenticated and index == len(routes) - 1:
            # Even a valid global directive-order override must not put the
            # terminating proxy before authentication or the generated guard.
            if require_origin_guard and not guarded:
                raise ValueError("Foreign Origin rejection must execute before proxying")
            proxied = True
        else:
            raise ValueError("Authentication and Origin checks must execute before proxying; complex ordering requires manual review")
    if not authenticated or not proxied or (require_origin_guard and not guarded):
        raise ValueError("A protected final proxy route is required")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def verify_login(url, username, password):
    if not re.fullmatch(r"https://[a-z0-9.-]+(?::\d+)?/(?:[A-Za-z0-9_-]+/)*", url):
        raise ValueError("Verification requires a plain HTTPS entry; redirects are refused")
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    def status(authorization=None):
        headers = {"Cache-Control": "no-cache"}
        if authorization:
            headers["Authorization"] = authorization
        request = urllib.request.Request(url, headers=headers)
        try:
            with opener.open(request, timeout=15) as response:
                return response.status
        except urllib.error.HTTPError as error:
            code = error.code
            error.close()
            return code
    if status() != 401:
        raise ValueError("Anonymous access was not rejected with 401; check gateway authentication")
    credential = base64.b64encode(f"{username}:{password}".encode()).decode()
    if status("Basic " + credential) != 200:
        raise ValueError("New login did not return HTTP 200; check credentials, tunnel and Pi listener")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["setup", "change", "recover", "verify"])
    parser.add_argument("--domain", default=PLAN["domain"] if PLAN else None)
    parser.add_argument("--url", default=PLAN["publicUrl"] if PLAN else None)
    parser.add_argument("--upstream-port", type=int, default=PLAN["remotePort"] if PLAN else None)
    parser.add_argument("--site-file", help="Server host path to the dedicated single-site Caddyfile")
    parser.add_argument("--main-config", help="Caddy-visible path to the full main config (host or selected container)")
    parser.add_argument("--docker-container", help="Explicit existing Caddy container; no container is created/restarted")
    parser.add_argument("--keep-old", action="store_true", help="Keep old account when explicitly renaming")
    args = parser.parse_args()
    domain = args.domain or ""
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", domain):
        raise ValueError("Specify the exact domain")
    if not sys.stdin.isatty():
        raise ValueError("Run interactively in your own trusted terminal; do not pipe credentials")
    if args.action == "verify":
        user = safe_user(input("Web login username: ").strip())
        password = getpass.getpass("Web login password (not saved): ")
        verify_login(args.url or f"https://{domain}/", user, password)
        print("VERIFIED: HTTPS rejects anonymous requests and the new account returns HTTP 200. Check WebSocket in the browser separately.")
        return
    if not args.site_file or not args.main_config:
        raise ValueError("Specify --site-file and --main-config; these are never guessed")
    target = pathlib.Path(args.site_file).absolute()
    if target.is_symlink() or not target.parent.is_dir():
        raise ValueError("Use a real site file in an existing directory")
    if args.docker_container and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", args.docker_container):
        raise ValueError("Invalid Caddy container name")
    command = ["docker", "exec", "-i", args.docker_container, "caddy"] if args.docker_container else ["caddy"]
    print(f"Target: {target}\nDomain: {domain}\nFull config: {args.main_config}")
    print("Existing credentials stay active until validated reload. This may affect every Pi session behind this site.")
    if input("Type the exact domain to authorize maintenance: ").strip() != domain:
        raise ValueError("Cancelled; no changes")
    lock_path = target.with_name(target.name + ".pi-web-lock")
    lock_fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "a", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        old_text = target.read_text() if target.exists() else None
        if args.action == "setup" and old_text is not None:
            raise ValueError("Setup refuses to overwrite an existing site; use change/recover")
        if args.action != "setup" and old_text is None:
            raise ValueError("Existing site not found")
        old_user = safe_user(input("Current web username to replace: ").strip()) if old_text else None
        new_user = safe_user(input("New web username (no default): ").strip())
        password = getpass.getpass("New web password (12-72 UTF-8 bytes): ")
        if not 12 <= len(password.encode()) <= 72 or "\n" in password or "\r" in password or "\x00" in password:
            raise ValueError("Password must be 12-72 UTF-8 bytes, without line breaks/NUL")
        if password != getpass.getpass("Confirm new password: "):
            raise ValueError("Passwords differ; no changes")
        result = subprocess.run(command + ["hash-password", "--algorithm", "bcrypt"], input=password + "\n", text=True, capture_output=True, check=True, timeout=60)
        password_hash = result.stdout.strip()
        del password
        if old_text:
            candidate = update_account(old_text, domain, old_user, new_user, password_hash, args.keep_old)
        else:
            if not args.upstream_port or not 1 <= args.upstream_port <= 65535:
                raise ValueError("Specify a loopback upstream port from 1 to 65535")
            candidate = new_site(domain, new_user, password_hash, args.upstream_port)
        def run_caddy(action):
            # Never print Caddy errors/config fragments which may contain hashes.
            subprocess.run(command + [action, "--config", args.main_config, "--adapter", "caddyfile"], capture_output=True, check=True, timeout=60)
        def validate():
            run_caddy("validate")
            adapted = subprocess.run(command + ["adapt", "--config", args.main_config, "--adapter", "caddyfile"], capture_output=True, check=True, timeout=60)
            check_effective_config(json.loads(adapted.stdout), domain, new_user, password_hash, require_origin_guard="@foreignOrigin" in candidate)
        backup = apply_config(target, candidate, validate, lambda: run_caddy("reload"), expected_original=old_text)
        print(f"APPLIED: config validated and reloaded. Backup: {backup or 'new site'}")
        print("NOT YET VERIFIED: run this tool with 'verify' from a client with HTTPS access, then check browser WebSocket. You may need to log in again.")


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        # Subprocess command arguments contain paths only; never dump subprocess output.
        print(f"Maintenance stopped: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
