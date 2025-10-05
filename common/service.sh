#!/system/bin/sh
MODDIR=${0%/*}

set_perm_if_exists() {
    local path="$1"
    local mode="$2"
    if [ -f "$path" ]; then
        chmod "$mode" "$path"
    fi
}

set_perm_if_exists "$MODDIR/post-fs-data.sh" 0755
set_perm_if_exists "$MODDIR/list.sh" 0644
set_perm_if_exists "$MODDIR/extra.sh" 0755

INFO=/data/adb/modules/.debloat_apmods-files
MODID=debloat_apmods
LIBDIR=/system
PROPFILE="$MODDIR/module.prop"

if [ -e "$MODDIR/on.c" ]; then
    sed -Ei 's/^description=(\[.*][[:space:]]*)?/description=[ ⛔ Module is not working! Delete module, reboot and reinstall / [Módulo no está funcionando correctamente]Elimina el módulo, reinicia y flashea de nuevo] /g' "$PROPFILE"
else
    sed -Ei 's/^description=(\[.*][[:space:]]*)?/description=[ ✅ Module is working ] /g' "$PROPFILE"
fi
