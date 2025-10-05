#!/sbin/sh
#########################
# Script de generación JSON de apps del sistema
#########################

OUTFD=$2
ZIPFILE=$3

mount /data 2>/dev/null
mount /system 2>/dev/null
mount /product 2>/dev/null

# Rutas de búsqueda
SD_CARD=/sdcard
S_APP=/system/app
P_APP=/product/app
S_PA=/system/priv-app
P_PA=/product/priv-app
SE_APP=/system/system_ext/app
SE_PA=/system/system_ext/priv-app
P_O=/product/overlay

# Archivo JSON de salida
TXT=/sdcard/Android/data/debloat_webui/files/apps.json";

ui_print "- Generando lista de apps en JSON..."

# Crear inicio del JSON
echo "[" > "$TXT"

# Función para agregar entradas al JSON
add_apps_from_dir() {
    DIR=$1
    if [ -d "$DIR" ]; then
        for APPDIR in "$DIR"/*; do
            if [ -d "$APPDIR" ]; then
                APP_NAME=$(basename "$APPDIR")
                echo "{\"name\":\"$APP_NAME\",\"path\":\"$APPDIR\"}," >> "$TXT"
            fi
        done
    fi
}

# Recorrer todas las rutas
add_apps_from_dir "$S_APP"
add_apps_from_dir "$P_APP"
add_apps_from_dir "$S_PA"
add_apps_from_dir "$P_PA"
add_apps_from_dir "$SE_APP"
add_apps_from_dir "$SE_PA"
add_apps_from_dir "$P_O"

# Quitar la última coma (si hay más de 1 línea)
LINE_COUNT=$(wc -l < "$TXT")
if [ "$LINE_COUNT" -gt 1 ]; then
    head -n -1 "$TXT" > "$TXT.tmp"
    tail -n 1 "$TXT" | sed 's/^,//' >> "$TXT.tmp"
    mv "$TXT.tmp" "$TXT"
fi

# Cerrar el JSON
echo "]" >> "$TXT"

ui_print "- apps.json generado en: $TXT"

exit 0
