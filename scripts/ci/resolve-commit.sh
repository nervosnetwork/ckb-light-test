#!/bin/sh
# Print one immutable commit for every backend in the same regression run.
set -eu
url=${1:?expected HTTPS repository URL}
ref=${2:?expected branch, tag or commit}
case "$url" in https://*) ;; *) echo "expected an HTTPS repository URL" >&2; exit 2;; esac
case "$ref" in
  *[!0123456789aAbBcCdDeEfF]*) ;;
  *) if [ "${#ref}" -eq 40 ]; then
       printf '%s\n' "$ref" | tr 'A-F' 'a-f'
       exit 0  # The checkout verifies that this commit exists.
     fi;;
esac
case "$ref" in
  refs/heads/*|refs/tags/*) head="$ref"; tag="$ref";;
  -*) echo "invalid source ref: $ref" >&2; exit 2;;
  *) head="refs/heads/$ref"; tag="refs/tags/$ref";;
esac
git check-ref-format "$head"
git check-ref-format "$tag"
refs=$(git ls-remote --exit-code "$url" "$head" "$tag" "$tag^{}")
# A short branch name takes precedence over a same-name tag. Peel annotated tags.
commit=$(printf '%s\n' "$refs" | awk -v h="$head" -v t="$tag" '
  $2 == h { head=$1 } $2 == t { tag=$1 } $2 == t "^{}" { peeled=$1 }
  END { if (head && h != t) print head; else if (peeled) print peeled; else if (tag) print tag }')
printf '%s\n' "$commit" | grep -Eq '^[0-9a-f]{40}$'
printf '%s\n' "$commit"
