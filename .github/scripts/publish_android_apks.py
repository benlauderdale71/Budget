"""Publish the signed Budget APKs tracked in downloads/android as GitHub Releases."""

import hashlib
import json
import os
import re
import shlex
import subprocess
from collections import defaultdict
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def github(url, method="GET", *, fields=None, apk=None):
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {os.environ['GH_TOKEN']}",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if apk is not None:
        headers["Content-Type"] = "application/vnd.android.package-archive"
        headers["Content-Length"] = str(apk.stat().st_size)
        with apk.open("rb") as stream:
            with urlopen(Request(url, stream, headers, method=method), timeout=180) as response:
                return json.load(response)
    data = None
    if fields is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(fields).encode()
    with urlopen(Request(url, data, headers, method=method), timeout=60) as response:
        return json.load(response) if response.status != 204 else None


def existing_releases(url):
    releases = {}
    page = 1
    while True:
        batch = github(f"{url}?per_page=100&page={page}")
        releases.update((item["tag_name"], item) for item in batch)
        if len(batch) < 100:
            return releases
        page += 1


def android_build_tools():
    root = Path(os.environ["ANDROID_HOME"]) / "build-tools"
    versions = [p for p in root.iterdir() if re.fullmatch(r"\d+\.\d+\.\d+", p.name)
                and (p / "apksigner").is_file() and (p / "aapt").is_file()]
    if not versions:
        raise RuntimeError(f"Android Build Tools with aapt and apksigner are required in {root}")
    return max(versions, key=lambda p: tuple(map(int, p.name.split("."))))


def describe(apk, tools):
    subprocess.run([tools / "apksigner", "verify", apk], check=True)
    badging = subprocess.check_output([tools / "aapt", "dump", "badging", apk], text=True)
    manifest = dict(arg.split("=", 1) for arg in shlex.split(badging.splitlines()[0])[1:])
    package, code, version = (manifest[key] for key in ("name", "versionCode", "versionName"))
    if package not in {"com.budgetcents.app", "com.budgetcents.app.test", "com.budgetcents.app.preview"}:
        raise ValueError(f"{apk} has an unexpected application ID: {package}")
    side_by_side = package.endswith((".test", ".preview"))
    test = (side_by_side or "application-debuggable" in badging.splitlines()
            or apk.name.lower().endswith(("-test.apk", "-devrelease.apk", "-debug.apk")))
    tag = f"android-{'test-' if test else ''}build-{int(code)}"
    title = f"Budget HQ Pro {version} for Android (build {code})" + (" – Test" if test else "")
    notes = "Download the Android APK under **Assets**."
    if package.endswith(".preview"):
        notes += " Install **Budget HQ PRO Preview** alongside the previous Test build. Sign in with your existing Budget HQ Pro account."
    elif side_by_side:
        notes += " This test build installs alongside Budget HQ Pro as **Budget HQ PRO Test**."
    with apk.open("rb") as stream:
        digest = "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest()
    return tag, {"name": title, "body": notes, "prerelease": test}, digest


def publish(url, existing, tag, details, files):
    release = existing.get(tag)
    if release is None:
        release = github(url, "POST", fields={
            **details, "tag_name": tag, "target_commitish": os.environ["GITHUB_SHA"], "draft": True,
        })
    assets = {asset["name"]: asset for asset in release["assets"]}
    for apk, digest in files.items():
        asset = assets.get(apk.name)
        if asset and asset["state"] == "starter" and release["draft"]:
            # GitHub can leave an empty draft asset after an interrupted upload.
            github(asset["url"], "DELETE")
            asset = None
        if asset is None:
            upload = release["upload_url"].split("{", 1)[0]
            asset = github(f"{upload}?{urlencode({'name': apk.name})}", "POST", apk=apk)
        if (asset["state"] != "uploaded" or asset["size"] != apk.stat().st_size
                or asset.get("digest") != digest):
            raise ValueError(f"{tag}/{apk.name} differs from the signed APK. Use a new versionCode for a new build.")
    if release["draft"]:
        release = github(release["url"], "PATCH", fields={"draft": False})
    print(release["html_url"], flush=True)


def main():
    output = subprocess.check_output(["git", "ls-files", "-z", "--", "downloads/android/"])
    apks = [Path(os.fsdecode(name)) for name in output.split(b"\0") if name.endswith(b".apk")]
    if not apks:
        return
    tools = android_build_tools()
    groups = defaultdict(dict)
    details = {}
    for apk in apks:
        tag, metadata, digest = describe(apk, tools)
        if (tag in details and details[tag] != metadata) or any(p.name == apk.name for p in groups[tag]):
            raise ValueError(f"{tag} contains conflicting APK versions or filenames")
        details[tag] = metadata
        groups[tag][apk] = digest
    url = f"https://api.github.com/repos/{os.environ['GITHUB_REPOSITORY']}/releases"
    existing = existing_releases(url)
    for tag, files in groups.items():
        publish(url, existing, tag, details[tag], files)


if __name__ == "__main__":
    try:
        main()
    except HTTPError as error:
        raise SystemExit(f"GitHub returned {error.code}: {error.read().decode(errors='replace')}") from error
