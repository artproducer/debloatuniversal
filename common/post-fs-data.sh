#!/system/bin/sh
# Autogenerado por Debloat Universal WebUI (plantilla inicial)
MODDIR=${0%/*}
remove=""
replace=""

cleanup_artifacts() {
  local suffix="$1"
  local find_type="$2"
  find "$MODDIR" $find_type -name "*$suffix" 2>/dev/null | while read -r entry; do
    if [ "$suffix" = ".remove" ]; then
      rm -f "$entry"
    else
      rm -rf "$entry"
    fi
  done
}

apply_list() {
  local list="$1"
  local suffix="$2"
  [ -n "$list" ] || return 0
  for target in $list; do
    local dest="$MODDIR${target}${suffix}"
    local parent="$(dirname "$dest")"
    mkdir -p "$parent"
    if [ "$suffix" = ".remove" ]; then
      touch "$dest"
    else
      mkdir -p "$dest"
    fi
  done
}

if [ -n "$remove" ]; then
  cleanup_artifacts ".replace" "-type d"
  cleanup_artifacts ".remove" "-type f"
  apply_list "$remove" ".remove"
elif [ -n "$replace" ]; then
  cleanup_artifacts ".remove" "-type f"
  cleanup_artifacts ".replace" "-type d"
  apply_list "$replace" ".replace"
else
  cleanup_artifacts ".remove" "-type f"
  cleanup_artifacts ".replace" "-type d"
fi

exit 0
