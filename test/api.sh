#!/bin/bash
# API permission checks against a running local server (after seed.mjs).
B=http://localhost:4350; J='Content-Type: application/json'; PW=demo-pass-123
c() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
echo "unauth meetings (401):        $(c $B/api/meetings)"
echo "form-post login (415):        $(c -XPOST $B/api/auth/login -d email=x)"
echo "wrong password (401):         $(c -XPOST $B/api/auth/login -H "$J" -d '{"email":"demo@meetingbot.test","password":"nope"}')"
curl -s -c /tmp/mb_a -XPOST $B/api/auth/login -H "$J" -d "{\"email\":\"demo@meetingbot.test\",\"password\":\"$PW\"}" >/dev/null
curl -s -c /tmp/mb_f -XPOST $B/api/auth/login -H "$J" -d "{\"email\":\"sam@meetingbot.test\",\"password\":\"$PW\"}" >/dev/null
# Both start in their personal workspace; switch to the shared one.
WS=$(curl -s -b /tmp/mb_a $B/api/me | node -pe "JSON.parse(require('fs').readFileSync(0)).workspaces.find(w=>w.name==='Acme').id")
curl -s -b /tmp/mb_a -XPOST $B/api/workspaces/switch -H "$J" -d "{\"id\":\"$WS\"}" >/dev/null
echo "owner sees demo meeting (200): $(c -b /tmp/mb_a $B/api/meetings/demo0001)"
echo "sam personal ws, demo (404): $(c -b /tmp/mb_f $B/api/meetings/demo0001)"
echo "recording, wrong ws (404):    $(c -b /tmp/mb_f $B/recordings/demo0001.webm)"
curl -s -b /tmp/mb_f -XPOST $B/api/workspaces/switch -H "$J" -d "{\"id\":\"$WS\"}" >/dev/null
echo "member sees it now (200):     $(c -b /tmp/mb_f $B/api/meetings/demo0001)"
echo "recording, member (200):      $(c -b /tmp/mb_f $B/recordings/demo0001.webm)"
echo "member invites (403):         $(c -b /tmp/mb_f -XPOST $B/api/workspace/invites -H "$J" -d '{"email":"x@y.co"}')"
FID=$(curl -s -b /tmp/mb_f $B/api/me | node -pe "JSON.parse(require('fs').readFileSync(0)).user.id")
echo "owner -> sam viewer (200): $(c -b /tmp/mb_a -XPATCH $B/api/workspace/members/$FID -H "$J" -d '{"role":"viewer"}')"
echo "viewer adds task (403):       $(c -b /tmp/mb_f -XPOST $B/api/tasks -H "$J" -d '{"title":"x"}')"
echo "viewer lists tasks (200):     $(c -b /tmp/mb_f "$B/api/tasks?status=all")"
c -b /tmp/mb_a -XPATCH $B/api/workspace/members/$FID -H "$J" -d '{"role":"member"}' >/dev/null
AID=$(curl -s -b /tmp/mb_a $B/api/me | node -pe "JSON.parse(require('fs').readFileSync(0)).user.id")
echo "demote last owner (400):      $(c -b /tmp/mb_a -XPATCH $B/api/workspace/members/$AID -H "$J" -d '{"role":"member"}')"
echo "search 'photographer':        $(curl -s -b /tmp/mb_a "$B/api/meetings?q=photographer" | node -pe "JSON.parse(require('fs').readFileSync(0)).length") result(s)"
echo "mine (alex):                 $(curl -s -b /tmp/mb_a "$B/api/tasks?mine=1" | node -pe "JSON.parse(require('fs').readFileSync(0)).map(t=>t.title).join(', ')")"
echo "logout then me (401):         $(curl -s -b /tmp/mb_f -c /tmp/mb_f -XPOST $B/api/auth/logout -H "$J" >/dev/null; c -b /tmp/mb_f $B/api/me)"
rm -f /tmp/mb_a /tmp/mb_f
