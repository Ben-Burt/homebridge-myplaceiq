#!/usr/bin/env bash
#
# Release helper for homebridge-myplaceiq.
#
#   bash scripts/release.sh            release the version in package.json
#   bash scripts/release.sh --dry-run  run the checks and show the plan only
#
# Run it from your own terminal: it uses your git, npm and (optionally) gh
# logins. Safe to re-run after a failure - every step is skipped if it has
# already been done.
# Order: checks -> commit -> push -> tag -> npm publish -> GitHub release.
#
set -euo pipefail

DRY=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY=1 ;;
  *) echo "usage: bash scripts/release.sh [--dry-run]" >&2; exit 2 ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")/.."

PKG=$(node -p "require('./package.json').name")
VER=$(node -p "require('./package.json').version")
TAG="v$VER"
REPO=$(git remote get-url origin | sed -E 's#^(git@github.com:|https://github.com/)##; s#\.git$##')
PROBLEMS=0

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
skip() { printf '  skip  %s\n' "$*"; }
warn() { printf '  warn  %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; PROBLEMS=$((PROBLEMS + 1)); }
die()  { printf '  FAIL  %s\n' "$*"; exit 1; }
run()  {
  if (( DRY )); then printf '  would run: %s\n' "$*"
  else printf '  running:   %s\n' "$*"; "$@"; fi
}

if (( DRY )); then say "Releasing $PKG $TAG  (dry run - nothing will be changed)"
else say "Releasing $PKG $TAG"; fi

# ---------------------------------------------------------------- checks
say; say "Checks"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" == "main" ]]; then ok "on branch main"; else bad "on branch '$BRANCH', expected main"; fi

TOP=$(grep -m1 '^## \[' CHANGELOG.md | sed -E 's/^## \[([^]]+)\].*/\1/' || true)
if [[ "$TOP" == "$VER" ]]; then ok "CHANGELOG top entry matches package.json ($VER)"
else bad "CHANGELOG top entry is '$TOP' but package.json says $VER"; fi

before=$PROBLEMS
for f in index.js lib/*.js; do
  node --check "$f" 2>/dev/null || bad "syntax error in $f"
done
if (( PROBLEMS == before )); then ok "JS syntax (index.js, lib/*.js)"; fi

before=$PROBLEMS
for f in package.json config.schema.json; do
  node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" 2>/dev/null || bad "$f is not valid JSON"
done
if (( PROBLEMS == before )); then ok "package.json and config.schema.json are valid JSON"; fi

if node -e "
  const s = JSON.parse(require('fs').readFileSync('config.schema.json','utf8'));
  const props = (s.schema && s.schema.properties) || {};
  const bad = Object.entries(props).filter(([, v]) => typeof v.required === 'boolean').map(([k]) => k);
  if (bad.length) process.exit(1);
" 2>/dev/null; then ok "config.schema.json has no per-field \"required\": true/false"
else bad "config.schema.json uses per-field \"required\" booleans (Homebridge verification rejects this)"; fi

if grep -rIlE --exclude-dir=.git --exclude-dir=node_modules --exclude=release.sh 'YOUR_GITHUB_USERNAM[E]|YOUR NAME OR GITHU[B]' . >/dev/null 2>&1; then
  bad "placeholder text (YOUR_GITHUB_USERNAME / YOUR NAME...) still present"
else ok "no leftover placeholders"; fi

NPM_USER=$(npm whoami 2>/dev/null || true)
if [[ -n "$NPM_USER" ]]; then ok "npm logged in as $NPM_USER"
else bad "not logged in to npm - run: npm login"; fi

if git push --dry-run origin HEAD >/dev/null 2>&1; then ok "GitHub push access"
else bad "cannot push to GitHub (expired token?) - fix your git credentials first"; fi

DIRTY=$(git status --porcelain)

if (( PROBLEMS > 0 )); then
  say
  say "$PROBLEMS check(s) failed."
  if (( DRY )); then say "(dry run - showing the plan anyway)"
  else say "Fix the above and re-run. Nothing has been changed."; exit 1; fi
fi

# ---------------------------------------------------------------- actions
say; say "Steps"

# 1. commit
if [[ -n "$DIRTY" ]]; then
  say "  uncommitted changes:"; git status --short | sed 's/^/    /'
  if (( DRY )); then
    say "  would run: git add -A && git commit"
  else
    read -r -p "  Commit message [$TAG]: " MSG
    MSG=${MSG:-$TAG}
    git add -A
    git commit -m "$MSG"
  fi
else skip "nothing to commit"; fi

# 2. push main
AHEAD=$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
if [[ -n "$DIRTY" || "$AHEAD" != "0" ]]; then run git push origin main
else skip "main is already pushed"; fi

# 3. tag (and push it)
if [[ -n "$DIRTY" ]] && (( DRY )); then
  say "  would run: git tag $TAG && git push origin $TAG   (after the commit above)"
else
  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    if [[ "$(git rev-list -n1 "$TAG")" == "$(git rev-parse HEAD)" ]]; then
      skip "tag $TAG already on this commit"
    else
      die "tag $TAG exists but points at a different commit than HEAD. If it is stale: git tag -d $TAG && git push origin :refs/tags/$TAG, then re-run"
    fi
  else run git tag "$TAG"; fi

  if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
    skip "tag $TAG already on GitHub"
  else run git push origin "$TAG"; fi
fi

# 4. npm publish
if [[ -n "$(npm view "$PKG@$VER" version 2>/dev/null || true)" ]]; then
  skip "$PKG@$VER is already on npm"
else run npm publish; fi

# 5. GitHub release, with notes taken from the matching CHANGELOG section
NOTES=$(awk -v v="$VER" '
  /^## \[/ { if (found) exit; if (index($0, "## [" v "]") == 1) { found = 1; next } }
  found { print }' CHANGELOG.md)

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  if gh release view "$TAG" >/dev/null 2>&1; then skip "GitHub release $TAG already exists"
  elif (( DRY )); then say "  would run: gh release create $TAG (notes from CHANGELOG)"
  else
    say "  running:   gh release create $TAG"
    printf '%s\n' "$NOTES" | gh release create "$TAG" --verify-tag --title "$TAG" --notes-file -
  fi
else
  warn "gh CLI not installed or not logged in, so create the release by hand:"
  say  "        https://github.com/$REPO/releases/new?tag=$TAG"
  say  "        title: $TAG    notes:"
  printf '%s\n' "$NOTES" | sed 's/^/          /'
fi

say
if (( DRY )); then say "Dry run finished - nothing was changed."
else
  say "Done: $PKG $TAG."
  say "Update the Homebridge server with:"
  say "  sudo -u homebridge npm install -g $PKG@latest && sudo systemctl restart homebridge"
fi
