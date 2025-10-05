#!/system/bin/sh
SKIPMOUNT=false
PROPFILE=true
POSTFSDATA=true
LATESTARTSERVICE=true

set_perm_file() {
    local file="$1"
    local mode="$2"
    if [ -f "$file" ]; then
        chmod "$mode" "$file"
    fi
}

set_perm_executable() {
    local file="$1"
    if [ -f "$file" ]; then
        chmod 0755 "$file"
    fi
}

copy_if_exists() {
    local src="$1"
    local dst="$2"
    if [ -f "$src" ]; then
        cp -fp "$src" "$dst"
    fi
}

ui_print "- Preparando archivos del módulo"

# Plantilla de post-fs-data
copy_if_exists "$MODPATH/common/post-fs-data.sh" "$MODPATH/post-fs-data.sh"
set_perm_executable "$MODPATH/post-fs-data.sh"

# Copiar lista de recomendados a la raíz del módulo
copy_if_exists "$MODPATH/common/list.sh" "$MODPATH/list.sh"
set_perm_file "$MODPATH/list.sh" 0644

# Asegurar directorios auxiliares para artefactos
mkdir -p "$MODPATH/system" >/dev/null 2>&1
mkdir -p "$MODPATH/tmp" >/dev/null 2>&1

# Eliminar apps.json heredado (la interfaz ya no lo requiere)
rm -f "$MODPATH/webroot/apps.json"

ui_print "- Módulo configurado"
