const CONFIG = {
    SYSTEM_PATHS: [
        '/system/app',
        '/system/priv-app',
        '/product/app',
        '/product/priv-app',
        '/vendor/app',
        '/vendor/priv-app',
        '/system/system_ext/app',
        '/system/system_ext/priv-app',
        '/product/overlay'
    ],
    USER_PATHS: [
        '/data/app'
    ],
    MODULE_PATH: '/data/adb/modules/debloat_universal',
    LIST_SH_PATHS: [
        '/data/adb/modules/debloat_universal/list.sh',
        '/data/adb/modules/debloat_universal/common/list.sh'
    ],
    LIST_SH_FALLBACKS: [
        './list.sh',
        '../list.sh',
        './common/list.sh',
        '../common/list.sh'
    ],
    POST_FS_DATA_PATH: '/data/adb/modules/debloat_universal/common/post-fs-data.sh'
};

const STATE = {
    rootType: null,
    execFn: null,
    execMeta: null,
    systemApps: [],
    userApps: [],
    recommendedMap: new Map(),
    installedRecommendations: new Set(),
    searchTerm: '',
    currentFilter: 'all',
    currentTab: 'apps',
    renderedAppsCount: 0
};

function normalizeName(value) {
    return value ? String(value).trim().toLowerCase() : '';
}

function escapeHTML(value) {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function jsStringEscape(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
}

function shEscape(value) {
    return String(value).replace(/["\\$`]/g, '\\$&');
}

function normalizeCommandResult(result) {
    if (result === null || result === undefined) {
        return '';
    }
    if (typeof result === 'string') {
        return result.trim();
    }
    if (Array.isArray(result)) {
        return result.join('\n').trim();
    }
    if (typeof result === 'object') {
        const possibleKeys = ['stdout', 'out', 'output', 'result', 'message'];
        for (const key of possibleKeys) {
            if (key in result && result[key] != null) {
                return String(result[key]).trim();
            }
        }
        if (typeof result.toString === 'function' && result.toString !== Object.prototype.toString) {
            return String(result.toString()).trim();
        }
        try {
            return JSON.stringify(result);
        } catch {
            return String(result).trim();
        }
    }
    return String(result).trim();
}

function collectRootCandidates() {
    const providers = [
        { type: 'ksu', label: 'KernelSU', object: window.ksu },
        { type: 'ksu', label: 'KernelSU', object: window.KernelSU },
        { type: 'ksu', label: 'KernelSU', object: window.app?.ksu },
        { type: 'magisk', label: 'Magisk', object: window.magisk },
        { type: 'magisk', label: 'Magisk', object: window.Magisk },
        { type: 'magisk', label: 'Magisk', object: window.mm },
        { type: 'ksu', label: 'RootShell', object: window.su },
        { type: 'ksu', label: 'RootShell', object: window.rootShell },
        { type: 'ksu', label: 'RootShell', object: window.shell }
    ];

    const methods = ['exec', 'execAsync', 'shell', 'run', 'runCommand', 'execute', 'cmd', 'command', 'sh'];
    const candidates = [];
    const seenFunctions = new WeakSet();

    for (const provider of providers) {
        const base = provider.object;
        if (!base) {
            continue;
        }
        for (const method of methods) {
            const fn = base[method];
            if (typeof fn !== 'function' || seenFunctions.has(fn)) {
                continue;
            }
            seenFunctions.add(fn);
            const exec = async (command) => {
                const raw = await fn.call(base, command);
                return normalizeCommandResult(raw);
            };
            candidates.push({
                type: provider.type,
                label: provider.label,
                method,
                exec
            });
        }
    }

    return candidates;
}
async function tryKernelSUExec() {
    if (typeof window.ksu?.exec !== 'function') {
        return false;
    }

    log('🔧 Probando API window.ksu.exec', 'info');
    const exec = async (command) => normalizeCommandResult(await window.ksu.exec(command));

    STATE.rootType = 'ksu';
    STATE.execFn = exec;
    STATE.execMeta = { label: 'KernelSU', method: 'window.ksu.exec' };

    try {
        const whoami = await executeCommand('whoami');
        const hasRoot = whoami.toLowerCase().includes('root');

        try {
            const ksuVersion = await executeCommand('getprop ro.kernel.su.version || echo ""', { silent: true });
            if (ksuVersion.trim()) {
                STATE.execMeta.label = `KernelSU v${ksuVersion.trim()}`;
                log('ℹ️ KernelSU versión', 'info', ksuVersion.trim());
            }
        } catch (versionError) {
            log('⚠️ No se pudo obtener versión de KernelSU', 'warning', versionError.message);
        }

        setRootStatus(`${STATE.execMeta.label || 'KernelSU'} Conectado`, 'connected');
        log('✅ KernelSU detectado (API window.ksu.exec)', 'success');

        if (!hasRoot) {
            log('⚠️ whoami no devolvió "root"', 'warning', whoami || '(sin salida)');
        }

        updateStats();
        return true;
    } catch (error) {
        log('⚠️ KernelSU.exec no respondió correctamente', 'warning', error.message);
        STATE.rootType = null;
        STATE.execFn = null;
        STATE.execMeta = null;
        return false;
    }
}

async function finalizeRootDetection() {
    if (typeof STATE.execFn !== 'function') {
        return;
    }

    let whoamiOutput = '';
    try {
        whoamiOutput = await executeCommand('whoami');
        if (whoamiOutput && !whoamiOutput.toLowerCase().includes('root')) {
            log('⚠️ whoami no devolvió "root"', 'warning', whoamiOutput || '(sin salida)');
        }
    } catch (error) {
        log('⚠️ No se pudo ejecutar whoami', 'warning', error.message);
    }

    if (STATE.rootType === 'ksu') {
        try {
            const ksuVersion = await executeCommand('getprop ro.kernel.su.version || echo ""', { silent: true });
            if (ksuVersion.trim()) {
                STATE.execMeta = {
                    label: `KernelSU v${ksuVersion.trim()}`,
                    method: STATE.execMeta?.method || 'kernel'
                };
                log('ℹ️ KernelSU versión', 'info', ksuVersion.trim());
            }
        } catch (error) {
            log('⚠️ No se pudo obtener versión de KernelSU', 'warning', error.message);
        }
    } else if (STATE.rootType === 'magisk') {
        try {
            const magiskVersion = await executeCommand('magisk -v', { silent: true });
            if (magiskVersion.trim()) {
                STATE.execMeta = {
                    label: `Magisk ${magiskVersion.trim()}`,
                    method: STATE.execMeta?.method || 'magisk'
                };
                log('ℹ️ Magisk versión', 'info', magiskVersion.trim());
            }
        } catch (error) {
            try {
                const magiskPath = await executeCommand('which magisk 2>/dev/null || echo ""', { silent: true });
                if (magiskPath.trim()) {
                    log('ℹ️ Magisk detectado', 'info', magiskPath.trim());
                }
            } catch (pathError) {
                log('⚠️ No se pudo obtener información de Magisk', 'warning', error.message);
            }
        }
    }

    if (STATE.execMeta?.label) {
        setRootStatus(`${STATE.execMeta.label} Conectado`, 'connected');
    }

    updateStats();
}


function getDirname(path) {
    const idx = path.lastIndexOf('/');
    if (idx <= 0) {
        return '/';
    }
    return path.slice(0, idx);
}

function formatCount(count, singular, plural) {
    const value = Number(count) || 0;
    return `${value} ${value === 1 ? singular : plural}`;
}

function getDisplayNameFromPath(path) {
    const trimmed = (path || '').replace(/\/+$/, '');
    if (!trimmed) {
        return path || '';
    }
    const parts = trimmed.split('/').filter(Boolean);
    if (parts.length === 0) {
        return trimmed;
    }
    let candidate = parts[parts.length - 1];
    if (!candidate && parts.length >= 2) {
        candidate = parts[parts.length - 2];
    }
    const lower = candidate.toLowerCase();
    if (lower === 'base.apk' && parts.length >= 2) {
        candidate = parts[parts.length - 2];
    }
    if (candidate && candidate.toLowerCase().endsWith('.apk')) {
        return candidate.replace(/\.apk$/i, '');
    }
    return candidate || trimmed;
}

function buildAppRecord(apkPath, type) {
    const normalizedApk = (apkPath || '').trim().replace(/\/+$/, '');
    const baseDir = getDirname(normalizedApk);
    let directory;
    if (!baseDir || baseDir === normalizedApk) {
        directory = normalizedApk;
    } else if (CONFIG.SYSTEM_PATHS.includes(baseDir)) {
        directory = `${baseDir}/${getDisplayNameFromPath(normalizedApk)}`;
    } else {
        directory = baseDir;
    }
    const displayName = getDisplayNameFromPath(directory || normalizedApk);
    const identifier = normalizeName(displayName);

    return {
        id: `${type}:${directory || normalizedApk}`,
        name: displayName,
        path: normalizedApk,
        directory: directory || normalizedApk,
        removeTarget: directory || normalizedApk,
        type,
        action: 'keep',
        recommended: false,
        recommendationLabel: null,
        source: 'scan',
        uninstalled: false,
        identifier
    };
}

function getRootLabel() {
    if (STATE.execMeta?.label) {
        return STATE.execMeta.label;
    }
    if (STATE.rootType) {
        return STATE.rootType.toUpperCase();
    }
    return 'ROOT';
}

function log(message, type = 'info', details = null) {
    const logsContainer = document.getElementById('logsContainer');

    if (!logsContainer) {
        const method = type === 'error' ? 'error' : 'log';
        console[method](`[${type}] ${message}`, details ?? '');
        return;
    }

    const icons = {
        info: '🔷',
        success: '✅',
        warning: '⚠️',
        error: '❌'
    };

    const timestamp = new Date().toLocaleTimeString('es-ES', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });

    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;

    const detailsBlock = details
        ? `<pre class="log-details">${escapeHTML(details)}</pre>`
        : '';

    entry.innerHTML = `
        <span class="log-icon">${icons[type] || '📝'}</span>
        <div class="log-content">
            <span class="log-time">[${timestamp}]</span>
            <div class="log-message">${escapeHTML(message)}</div>
            ${detailsBlock}
        </div>
    `;

    logsContainer.insertBefore(entry, logsContainer.firstChild);

    while (logsContainer.children.length > 200) {
        logsContainer.removeChild(logsContainer.lastChild);
    }
}

function buildLogText(entry) {
    if (!entry) {
        return '';
    }

    const time = entry.querySelector('.log-time')?.textContent?.trim() ?? '';
    const icon = entry.querySelector('.log-icon')?.textContent?.trim() ?? '';
    const message = entry.querySelector('.log-message')?.textContent?.trim() ?? '';
    const details = entry.querySelector('.log-details')?.textContent ?? '';

    const base = [time, icon, message].filter(Boolean).join(' ').trim();

    if (!details) {
        return base;
    }

    const indentedDetails = details
        .replace(/\r/g, '')
        .split('\n')
        .map(line => line.trimEnd())
        .map(line => `  ${line}`)
        .join('\n');

    return `${base}\n${indentedDetails}`.trim();
}

async function copyLogsToClipboard() {
    const logsContainer = document.getElementById('logsContainer');
    if (!logsContainer || logsContainer.children.length === 0) {
        log('ℹ️ No hay registros para copiar', 'info');
        return;
    }

    const lines = Array.from(logsContainer.children)
        .reverse()
        .map(buildLogText)
        .filter(Boolean);

    if (lines.length === 0) {
        log('ℹ️ No hay registros para copiar', 'info');
        return;
    }

    const payload = lines.join('\n');

    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(payload);
        } else {
            const textarea = document.createElement('textarea');
            textarea.value = payload;
            textarea.setAttribute('readonly', 'true');
            textarea.style.position = 'absolute';
            textarea.style.left = '-9999px';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
        }

        log('📋 Logs copiados al portapapeles', 'success');
    } catch (error) {
        log('❌ No se pudieron copiar los logs', 'error', error.message);
    }
}

async function executeCommand(command, options = {}) {
    const { silent = false, previewLength = 80 } = options;

    if (typeof STATE.execFn !== 'function') {
        throw new Error('No hay API root disponible para ejecutar comandos');
    }

    if (!silent) {
        log(`Ejecutando: ${command}`, 'info');
    }

    try {
        const raw = await STATE.execFn(command);
        const normalized = normalizeCommandResult(raw);

        if (!silent) {
            const preview = normalized.length > previewLength
                ? `${normalized.slice(0, previewLength)}…`
                : normalized || '(sin salida)';
            log(`Resultado (${normalized.length} chars)`, 'success', preview);
        }

        return normalized;
    } catch (error) {
        if (!silent) {
            log(`❌ Error ejecutando comando: ${error.message}`, 'error');
        }
        throw error;
    }
}

function mergeAppLists(existing, incoming) {
    const previousMap = new Map();
    existing.forEach(app => {
        const key = app.removeTarget || app.path;
        previousMap.set(key, app);
    });

    return incoming.map(app => {
        const key = app.removeTarget || app.path;
        const previous = previousMap.get(key);
        if (previous) {
            return {
                ...app,
                action: previous.action,
                uninstalled: previous.uninstalled,
                recommended: app.recommended || previous.recommended,
                recommendationLabel: app.recommendationLabel || previous.recommendationLabel
            };
        }
        return app;
    });
}

function updateStats() {
    const systemRemoveCount = STATE.systemApps.filter(app => app.action === 'remove').length;
    const userRemoveCount = STATE.userApps.filter(app => app.action === 'remove' && !app.uninstalled).length;
    const totalMarked = systemRemoveCount + userRemoveCount;

    const removeCountEl = document.getElementById('removeCount');
    if (removeCountEl) {
        removeCountEl.textContent = String(totalMarked);
    }

    const replaceCountEl = document.getElementById('replaceCount');
    if (replaceCountEl) {
        replaceCountEl.textContent = String(systemRemoveCount);
    }

    const statsSystem = document.getElementById('statsSystem');
    if (statsSystem) {
        statsSystem.textContent = formatCount(STATE.systemApps.length, 'app de sistema', 'apps de sistema');
    }

    const statsUser = document.getElementById('statsUser');
    if (statsUser) {
        statsUser.textContent = formatCount(STATE.userApps.length, 'app de usuario', 'apps de usuario');
    }

    const statsFiltered = document.getElementById('statsFiltered');
    if (statsFiltered) {
        statsFiltered.textContent = formatCount(STATE.renderedAppsCount, 'coincidencia', 'coincidencias');
    }

    const applyInfo = document.getElementById('applyInfo');
    if (applyInfo) {
        if (!STATE.rootType) {
            applyInfo.textContent = 'Root no detectado';
        } else if (systemRemoveCount > 0) {
            applyInfo.textContent = `${getRootLabel()}: ${systemRemoveCount} pendientes`;
        } else {
            applyInfo.textContent = `${getRootLabel()}: Sin cambios`;
        }
    }

    const applyBtn = document.getElementById('applyBtn');
    if (applyBtn) {
        applyBtn.disabled = systemRemoveCount === 0 || !STATE.rootType;
    }
}
function renderApps() {
    const container = document.getElementById('appsContainer');
    if (!container) {
        return;
    }

    const search = STATE.searchTerm.trim().toLowerCase();
    const filter = STATE.currentFilter;

    const allApps = [...STATE.systemApps, ...STATE.userApps];

    const filtered = allApps.filter(app => {
        let include = true;

        if (filter === 'marked') {
            include = app.action === 'remove';
        } else if (filter === 'recommended') {
            include = app.recommended;
        } else if (filter === 'keep') {
            include = app.action !== 'remove';
        }

        if (include && search) {
            include =
                app.name.toLowerCase().includes(search) ||
                (app.path && app.path.toLowerCase().includes(search)) ||
                (app.directory && app.directory.toLowerCase().includes(search));
        }

        return include;
    }).sort((a, b) => {
        if (a.recommended !== b.recommended) {
            return a.recommended ? -1 : 1;
        }
        if (a.type !== b.type) {
            return a.type === 'system' ? -1 : 1;
        }
        return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
    });

    STATE.renderedAppsCount = filtered.length;

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none">
                    <path d="M9 12L11 14L15 10M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
                <p>${escapeHTML(allApps.length === 0 ? 'Presiona "Escanear Apps" para detectar aplicaciones' : 'No se encontraron resultados')}</p>
            </div>
        `;
        updateStats();
        return;
    }

    const methodLabel = STATE.rootType === 'magisk' ? '.replace' : '.remove';

    container.innerHTML = filtered.map(app => {
        const safePath = escapeHTML(app.path);
        const appName = escapeHTML(app.name);
        const safeDir = escapeHTML(app.removeTarget);
        const systemInfoMessage = STATE.rootType
            ? `Se aplicará <code>${escapeHTML(methodLabel)}</code> sobre <code>${safeDir || safePath}</code>`
            : 'Pendiente de root • Ejecuta manualmente el script desde la pestaña Acciones';
        const pathForJS = jsStringEscape(app.path);
        const nameForJS = jsStringEscape(app.name);
        const appType = app.type === 'system' ? '🔧 Sistema' : '👤 Usuario';
        const sourceLabel = app.source === 'scan' ? 'Escaneado' : app.source || 'Detectado';
        const statusBadge = app.uninstalled ? '<span style="color: var(--accent-danger); font-size: 0.7rem;">● Desinstalada</span>' : '';
        const actionLabel = app.action === 'remove' ? 'Eliminar' : 'Conservar';

        let actionButtons;

        if (app.type === 'user') {
            actionButtons = `
                <div class="app-actions" style="display: flex; gap: 0.5rem; margin-top: 1rem;">
                    <button onclick="setAppAction('${pathForJS}', 'keep')"
                            class="${app.action === 'keep' ? 'active' : ''}"
                            style="flex: 1;">Conservar</button>
                    <button onclick="setAppAction('${pathForJS}', 'remove')"
                            class="${app.action === 'remove' ? 'active-remove' : ''}"
                            style="flex: 1;">Marcar para Eliminar</button>
                </div>
                ${app.action === 'remove' ? `
                <div style="margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--border-color);">
                    <button onclick="uninstallUserApp('${pathForJS}', '${nameForJS}')"
                            class="btn btn-primary"
                            style="width: 100%; font-size: 0.875rem; padding: 0.75rem;"
                            ${app.uninstalled ? 'disabled' : ''}>
                        🗑️ Desinstalar App de Usuario
                    </button>
                </div>` : '' }
            `;
        } else {
            actionButtons = `
                <div class="app-actions">
                    <button onclick="setAppAction('${pathForJS}', 'keep')"
                            class="${app.action === 'keep' ? 'active' : ''}">Conservar</button>
                    <button onclick="setAppAction('${pathForJS}', 'remove')"
                            class="${app.action === 'remove' ? 'active-remove' : ''}">
                        ${STATE.rootType === 'magisk' ? '🔄 Replace' : '🗑️ Remove'}
                    </button>
                </div>
                ${app.action === 'remove' ? `
                <div style="margin-top: 0.75rem; padding: 0.5rem; background: var(--bg-secondary); border-radius: var(--radius-sm); text-align: center;">
                    <small style="color: var(--text-secondary);">
                        ${systemInfoMessage}
                    </small>
                </div>` : ''}
            `;
        }

        return `
            <div class="app-card ${app.uninstalled ? 'app-uninstalled' : ''}" data-path="${safePath}">
                <div class="app-card-header">
                    <div class="app-info">
                        <h3>${app.recommended ? '⚡ ' : ''}${appName} ${statusBadge}</h3>
                        <p>${safePath}</p>
                        <small style="color: var(--text-tertiary); font-size: 0.7rem; margin-top: 0.25rem; display: block;">
                            ${appType} • ${escapeHTML(sourceLabel)}
                        </small>
                        ${app.recommended ? `<small style="color: var(--accent-primary); font-size: 0.7rem; display: block; margin-top: 0.25rem;">${escapeHTML(app.recommendationLabel || app.name)}</small>` : ''}
                    </div>
                    <span class="action-badge ${app.action}">${actionLabel}</span>
                </div>
                ${actionButtons}
            </div>
        `;
    }).join('');

    updateStats();
}
function setAppAction(path, action) {
    const target = STATE.systemApps.find(app => app.path === path || app.removeTarget === path) ||
        STATE.userApps.find(app => app.path === path || app.removeTarget === path);

    if (!target || target.action === action) {
        return;
    }

    target.action = action;

    if (action === 'remove') {
        if (target.type === 'system') {
            log(`🔧 ${target.name} marcada para eliminar`, 'info', `Ruta: ${target.removeTarget}`);
        } else {
            log(`🔧 ${target.name} marcada para desinstalar`, 'info');
        }
    } else {
        log(`🔄 ${target.name} configurada para conservarse`, 'info');
    }

    renderApps();
}

function getPackageNameFromPath(path) {
    if (!path) {
        return null;
    }

    const parts = path.split('/');
    let apkFile = parts[parts.length - 1] || '';
    if (apkFile.toLowerCase() === 'base.apk' && parts.length >= 2) {
        apkFile = parts[parts.length - 2];
    }

    if (apkFile.toLowerCase().endsWith('.apk')) {
        const candidate = apkFile.replace(/\.apk$/i, '');
        if (candidate.includes('.')) {
            return candidate;
        }
    }

    const folder = parts.length >= 2 ? parts[parts.length - 2] : apkFile;
    if (!folder) {
        return null;
    }

    const commonPackages = {
        Chrome: 'com.android.chrome',
        Gmail: 'com.google.android.gm',
        Maps: 'com.google.android.apps.maps',
        YouTube: 'com.google.android.youtube',
        Drive: 'com.google.android.apps.docs',
        Photos: 'com.google.android.apps.photos',
        Calendar: 'com.google.android.calendar',
        Contacts: 'com.google.android.contacts',
        Camera2: 'com.android.camera2',
        Gallery2: 'com.android.gallery3d',
        Music: 'com.android.music',
        GmsCore: 'com.google.android.gms',
        Phonesky: 'com.android.vending',
        Velvet: 'com.google.android.googlequicksearchbox',
        PrintSpooler: 'com.android.printspooler',
        WebViewGoogle: 'com.google.android.webview'
    };

    return commonPackages[folder] || null;
}

async function getPackageNameFromApk(apkPath) {
    try {
        const command = `aapt dump badging "${shEscape(apkPath)}" 2>/dev/null`;
        const output = await executeCommand(command, { silent: true });
        const match = output.match(/name='([^']+)'/);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

async function uninstallUserApp(path, appName) {
    if (typeof STATE.execFn !== 'function') {
        log('⚠️ No se puede desinstalar sin una API root disponible', 'warning');
        return;
    }

    const confirmed = typeof confirm === 'function'
        ? confirm(`⚠️ ¿Estás seguro de que deseas desinstalar "${appName}"?\n\nEsta acción eliminará la app de usuario inmediatamente.`)
        : true;

    if (!confirmed) {
        return;
    }

    log(`🗑️ Intentando desinstalar ${appName}`, 'info', path);

    try {
        let packageName = getPackageNameFromPath(path);

        if (!packageName) {
            packageName = await getPackageNameFromApk(path);
        }

        if (!packageName) {
            const manualPackage = prompt('No se pudo detectar el paquete automáticamente.\n\nIngresa el nombre del paquete manualmente (ej: com.whatsapp):');
            if (!manualPackage || !manualPackage.trim()) {
                log('⚠️ Desinstalación cancelada: se necesita el nombre del paquete.', 'warning');
                return;
            }
            packageName = manualPackage.trim();
        }

        log('📦 Paquete detectado', 'info', packageName);

        const command = `pm uninstall ${packageName}`;
        log('▶️ Ejecutando desinstalación', 'info', command);

        const result = await executeCommand(command);
        if (result.toLowerCase().includes('success')) {
            log(`✅ ${appName} desinstalada correctamente`, 'success');
            const app = STATE.userApps.find(item => item.path === path || item.removeTarget === path);
            if (app) {
                app.uninstalled = true;
                app.action = 'keep';
            }
        } else {
            log('⚠️ La respuesta del sistema no indica éxito', 'warning', result || 'Sin salida');
        }
    } catch (error) {
        log('❌ Error durante la desinstalación', 'error', error.message);
    } finally {
        renderApps();
    }
}
function parseListSh(content) {
    const map = new Map();
    if (!content) {
        return map;
    }
    const match = content.match(/EXISTS="([\s\S]*?)"/);
    if (!match) {
        return map;
    }
    match[1].split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) {
            return;
        }
        const key = normalizeName(trimmed);
        if (key) {
            map.set(key, trimmed);
        }
    });
    return map;
}

async function loadRecommendedList() {
    if (STATE.recommendedMap.size > 0) {
        return true;
    }

    const loaders = [];

    if (typeof window.fs?.readFile === 'function') {
        (CONFIG.LIST_SH_PATHS || []).forEach(path => {
            loaders.push({ label: `fs:${path}`, load: () => window.fs.readFile(path, { encoding: 'utf8' }) });
        });
    }

    if (typeof STATE.execFn === 'function') {
        (CONFIG.LIST_SH_PATHS || []).forEach(path => {
            loaders.push({
                label: `shell:${path}`,
                load: async () => {
                    const command = `[ -f "${shEscape(path)}" ] && cat "${shEscape(path)}" || true`;
                    return executeCommand(command, { silent: true });
                }
            });
        });
    }

    if (typeof fetch === 'function') {
        (CONFIG.LIST_SH_FALLBACKS || []).forEach(path => {
            loaders.push({
                label: `fetch:${path}`,
                load: async () => {
                    const response = await fetch(path, { cache: 'no-store' });
                    if (response.ok) {
                        return response.text();
                    }
                    throw new Error(`${response.status} ${response.statusText}`);
                }
            });
        });
    }

    for (const loader of loaders) {
        try {
            const content = await loader.load();
            const map = parseListSh(content);
            if (map.size > 0) {
                STATE.recommendedMap = map;
                log('✅ Lista de recomendados cargada', 'success', `${map.size} entradas disponibles (${loader.label})`);
                return true;
            }
        } catch (error) {
            log('⚠️ No se pudo leer list.sh', 'warning', `${loader.label}\n${error.message}`);
        }
    }

    log('⚠️ No se encontraron recomendaciones en list.sh', 'warning');
    return false;
}

function markRecommendations(apps) {
    const hits = new Set();
    STATE.installedRecommendations.clear();

    apps.forEach(app => {
        const key = app.identifier;
        if (STATE.recommendedMap.has(key)) {
            app.recommended = true;
            app.recommendationLabel = STATE.recommendedMap.get(key);
            if (app.action !== 'remove') {
                app.action = 'remove';
            }
            STATE.installedRecommendations.add(key);
            hits.add(app.recommendationLabel || app.name);
        }
    });

    return Array.from(hits);
}

async function findApkPaths(basePath, options = {}) {
    const maxDepth = options.maxDepth ?? 2;
    const pattern = options.pattern ?? '*.apk';
    const escapedBase = shEscape(basePath);
    const escapedPattern = shEscape(pattern);
    const candidates = new Set();

    const commands = [
        `find "${escapedBase}" -maxdepth ${maxDepth} -type f -iname "${escapedPattern}" 2>/dev/null || true`,
        `(command -v toybox >/dev/null 2>&1 && toybox find "${escapedBase}" -maxdepth ${maxDepth} -type f -iname "${escapedPattern}" 2>/dev/null) || true`,
        `(command -v busybox >/dev/null 2>&1 && busybox find "${escapedBase}" -maxdepth ${maxDepth} -type f -iname "${escapedPattern}" 2>/dev/null) || true`,
        `find "${escapedBase}" -type f -iname "${escapedPattern}" 2>/dev/null || true`,
        `(command -v toybox >/dev/null 2>&1 && toybox find "${escapedBase}" -type f -iname "${escapedPattern}" 2>/dev/null) || true`,
        `(command -v busybox >/dev/null 2>&1 && busybox find "${escapedBase}" -type f -iname "${escapedPattern}" 2>/dev/null) || true`
    ];

    for (const command of commands) {
        let output;
        try {
            output = await executeCommand(command, { silent: true });
        } catch {
            continue;
        }

        if (!output) {
            continue;
        }

        output.split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && /\.apk$/i.test(line))
            .forEach(line => candidates.add(line));
    }

    return Array.from(candidates);
}

async function collectSystemApps() {
    const records = new Map();

    for (const basePath of CONFIG.SYSTEM_PATHS) {
        try {
            log('📂 Escaneando ruta de sistema', 'info', basePath);
            const apkPaths = await findApkPaths(basePath, { maxDepth: 2, pattern: '*.apk' });
            if (apkPaths.length === 0) {
                log('ℹ️ Sin coincidencias en la ruta', 'info', basePath);
                continue;
            }

            const uniqueTargets = new Set();

            apkPaths.forEach(apkPath => {
                const record = buildAppRecord(apkPath, 'system');
                if (!records.has(record.removeTarget)) {
                    records.set(record.removeTarget, record);
                }
                uniqueTargets.add(record.removeTarget);
            });
            const uniqueLabel = uniqueTargets.size !== apkPaths.length
                ? ` (${uniqueTargets.size} carpetas únicas)`
                : '';
            log('📦 APK detectados', 'info', `${apkPaths.length} archivos en ${basePath}${uniqueLabel}`);
        } catch (error) {
            log('⚠️ No se pudo leer la ruta', 'warning', `${basePath}\n${error.message}`);
        }
    }

    return Array.from(records.values());
}

async function collectUserApps() {
    const records = new Map();

    for (const basePath of CONFIG.USER_PATHS) {
        try {
            log('📂 Escaneando apps de usuario', 'info', basePath);
            const apkPaths = await findApkPaths(basePath, { maxDepth: 3, pattern: 'base.apk' });
            if (apkPaths.length === 0) {
                continue;
            }

            const uniqueTargets = new Set();

            apkPaths.forEach(apkPath => {
                const record = buildAppRecord(apkPath, 'user');
                if (!records.has(record.removeTarget)) {
                    records.set(record.removeTarget, record);
                }
                uniqueTargets.add(record.removeTarget);
            });
            const uniqueLabel = uniqueTargets.size !== apkPaths.length
                ? ` (${uniqueTargets.size} carpetas únicas)`
                : '';
            log('📱 APK detectados en usuario', 'info', `${apkPaths.length} archivos en ${basePath}${uniqueLabel}`);
        } catch (error) {
            log('⚠️ No se pudo leer la ruta de usuario', 'warning', `${basePath}\n${error.message}`);
        }
    }

    return Array.from(records.values());
}

async function scanApps() {
    if (typeof STATE.execFn !== 'function') {
        log('⚠️ No se puede escanear sin API root disponible', 'warning');
        return;
    }

    const scanBtn = document.getElementById('scanBtn');
    const originalContent = scanBtn ? scanBtn.innerHTML : null;

    if (scanBtn) {
        scanBtn.disabled = true;
        scanBtn.innerHTML = '<span class="loading"></span> Escaneando...';
    }

    log('🔎 Iniciando escaneo de aplicaciones...', 'info');

    try {
        await loadRecommendedList();

        const systemRecords = await collectSystemApps();
        const hits = markRecommendations(systemRecords);
        STATE.systemApps = mergeAppLists(STATE.systemApps, systemRecords);

        const userRecords = await collectUserApps();
        STATE.userApps = mergeAppLists(STATE.userApps, userRecords);

        renderApps();

        if (hits.length > 0) {
            log('⚡ Apps recomendadas detectadas', 'success', hits.join('\n'));
        } else if (STATE.recommendedMap.size > 0) {
            log('ℹ️ Ninguna app recomendada instalada', 'info');
        }

        log('✅ Escaneo completado', 'success', `Sistema: ${STATE.systemApps.length}\nUsuario: ${STATE.userApps.length}`);
    } catch (error) {
        log('❌ Error durante el escaneo', 'error', error.message);
    } finally {
        if (scanBtn && originalContent) {
            scanBtn.disabled = false;
            scanBtn.innerHTML = originalContent;
        }
        updateStats();
    }
}
function setRootStatus(text, statusClass) {
    const statusBadge = document.getElementById('statusBadge');
    if (!statusBadge) {
        return;
    }
    statusBadge.classList.remove('connected', 'error');
    if (statusClass) {
        statusBadge.classList.add(statusClass);
    }
    const statusText = statusBadge.querySelector('.status-text');
    if (statusText) {
        statusText.textContent = text;
    }
}

async function removeArtifactsWithExtension(moduleRoot, extension, keepSet) {
    const findType = extension === '.remove' ? '-type f' : '-type d';
    try {
        const command = `find "${shEscape(moduleRoot)}" ${findType} -name "*${extension}" 2>/dev/null`;
        const output = await executeCommand(command, { silent: true });
        if (!output) {
            return;
        }
        const lines = output.split('\n').map(line => line.trim()).filter(Boolean);
        for (const entry of lines) {
            if (!entry.startsWith(moduleRoot)) {
                continue;
            }
            const relative = entry.slice(moduleRoot.length).replace(new RegExp(`${extension}$`), '');
            if (keepSet.has(relative)) {
                continue;
            }
            await executeCommand(`rm -rf "${shEscape(entry)}"`, { silent: true });
        }
    } catch {
        // Ignorar errores de limpieza
    }
}

async function ensureModuleArtifacts(targetDirs) {
    const moduleRoot = CONFIG.MODULE_PATH.replace(/\/+$/, '');
    const keepSet = new Set(targetDirs);
    const activeExtension = '.replace';
    const inactiveExtension = '.remove';

    await removeArtifactsWithExtension(moduleRoot, inactiveExtension, new Set());
    await removeArtifactsWithExtension(moduleRoot, activeExtension, keepSet);

    for (const dir of targetDirs) {
        const moduleTarget = `${moduleRoot}${dir}${activeExtension}`;
        await executeCommand(`mkdir -p "${shEscape(moduleTarget)}"`);
    }
}

async function writePostFsDataScript(targetDirs) {
    const listString = targetDirs.join(' ');
    const replaceLine = targetDirs.length > 0 ? `REPLACE="${listString}"` : 'REPLACE=""';
    const postFsDir = getDirname(CONFIG.POST_FS_DATA_PATH);

    const script = `#!/system/bin/sh
# Autogenerado por Debloat Universal WebUI
MODDIR=\${0%/*}
${replaceLine}

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
    local dest="$MODDIR\${target}\${suffix}"
    local parent="$(dirname "$dest")"
    mkdir -p "$parent"
    mkdir -p "$dest"
  done
}

if [ -n "$REPLACE" ]; then
  cleanup_artifacts ".remove" "-type f"
  cleanup_artifacts ".replace" "-type d"
  apply_list "$REPLACE" ".replace"
else
  cleanup_artifacts ".remove" "-type f"
  cleanup_artifacts ".replace" "-type d"
fi

exit 0
`;

    await executeCommand(`mkdir -p "${shEscape(postFsDir)}"`, { silent: true });
    await executeCommand(`cat <<'EOF' > "${shEscape(CONFIG.POST_FS_DATA_PATH)}"
${script}
EOF`);
    await executeCommand(`chmod 0755 "${shEscape(CONFIG.POST_FS_DATA_PATH)}"`, { silent: true });
    log('📝 post-fs-data.sh actualizado', 'info', `${targetDirs.length} rutas registradas`);
}

async function applyChanges() {
    if (!STATE.rootType || typeof STATE.execFn !== 'function') {
        log('⚠️ No se pueden aplicar cambios sin root detectado', 'warning');
        return;
    }

    const systemTargets = STATE.systemApps
        .filter(app => app.action === 'remove')
        .map(app => app.removeTarget);

    const uniqueTargets = Array.from(new Set(systemTargets)).sort();

    const applyBtn = document.getElementById('applyBtn');
    const originalContent = applyBtn ? applyBtn.innerHTML : null;

    if (applyBtn) {
        applyBtn.disabled = true;
        applyBtn.innerHTML = '<span class="loading"></span> Aplicando...';
    }

    log('🚀 Iniciando aplicación de cambios...', 'info', `${uniqueTargets.length} rutas de sistema seleccionadas`);

    try {
        await ensureModuleArtifacts(uniqueTargets);
        await writePostFsDataScript(uniqueTargets);

        if (uniqueTargets.length > 0) {
            log('✅ Rutas añadidas al módulo', 'success', uniqueTargets.join('\n'));
        } else {
            log('ℹ️ No se configuraron rutas de sistema para eliminar', 'info');
        }

        const userPending = STATE.userApps.filter(app => app.action === 'remove' && !app.uninstalled).length;
        if (userPending > 0) {
            log('📱 Acciones pendientes', 'warning', `${userPending} apps de usuario marcadas. Usa el botón "Desinstalar App de Usuario" en cada tarjeta.`);
        }

        log('🔄 Se recomienda reiniciar el dispositivo para completar los cambios.', 'warning');

        if (typeof confirm === 'function' && confirm('¿Reiniciar el dispositivo ahora para aplicar los cambios del módulo?')) {
            log('🔄 Reiniciando dispositivo...', 'info');
            await executeCommand('reboot');
        }
    } catch (error) {
        log('❌ Error al aplicar los cambios', 'error', error.message);
    } finally {
        if (applyBtn && originalContent) {
            applyBtn.innerHTML = originalContent;
            applyBtn.disabled = false;
        }
        updateStats();
    }
}
async function detectEnvironment() {
    setRootStatus('Detectando...', null);
    log('🔍 Buscando APIs de root...', 'info');

    if (await tryKernelSUExec()) {
        return true;
    }

    const candidates = collectRootCandidates().filter(candidate => !(candidate.label === 'KernelSU' && candidate.method === 'exec'));

    if (candidates.length === 0) {
        STATE.rootType = null;
        STATE.execFn = null;
        STATE.execMeta = null;
        setRootStatus('Sin Root', 'error');
        updateStats();
        log('⚠️ No se encontró ninguna API root expuesta en la WebView.', 'warning');
        return false;
    }

    for (const candidate of candidates) {
        const token = candidate.type === 'magisk' ? 'MAGISK_READY' : 'KSU_READY';
        const probe = `echo ${token}`;

        try {
            const output = await candidate.exec(probe);
            const normalized = normalizeCommandResult(output);
            if (normalized.includes(token)) {
                STATE.rootType = candidate.type === 'magisk' ? 'magisk' : 'ksu';
                STATE.execFn = candidate.exec;
                STATE.execMeta = { label: candidate.label, method: candidate.method };
                setRootStatus(`${candidate.label} Conectado`, 'connected');
                log(`✅ ${candidate.label} detectado`, 'success', `API: ${candidate.method}()`);
                await finalizeRootDetection();
                return true;
            }
        } catch (error) {
            log(`⚠️ Falló la detección de ${candidate.label}`, 'warning', `API: ${candidate.method}()
${error.message}`);
        }
    }

    STATE.rootType = null;
    STATE.execFn = null;
    STATE.execMeta = null;
    setRootStatus('Sin Root', 'error');
    updateStats();
    log('❌ No se detectó KernelSU ni Magisk. Las funciones avanzadas estarán limitadas.', 'error');
    return false;
}

function initEventListeners() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.dataset.tab;
            if (!tabId) {
                return;
            }

            STATE.currentTab = tabId;

            document.querySelectorAll('.tab-btn').forEach(other => {
                other.classList.toggle('active', other === btn);
            });

            document.querySelectorAll('.tab-pane').forEach(panel => {
                panel.classList.toggle('active', panel.dataset.tab === tabId);
            });
        });
    });

    document.querySelectorAll('.chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const filter = chip.dataset.filter || 'all';
            STATE.currentFilter = filter;

            document.querySelectorAll('.chip').forEach(other => {
                other.classList.toggle('active', other === chip);
            });

            renderApps();
        });
    });

    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', event => {
            STATE.searchTerm = event.target.value || '';
            renderApps();
        });
    }

    const scanBtn = document.getElementById('scanBtn');
    if (scanBtn) {
        scanBtn.addEventListener('click', scanApps);
    }

    const applyBtn = document.getElementById('applyBtn');
    if (applyBtn) {
        applyBtn.addEventListener('click', applyChanges);
    }

    const clearLogsBtn = document.getElementById('clearLogsBtn');
    if (clearLogsBtn) {
        clearLogsBtn.addEventListener('click', () => {
            const logsContainer = document.getElementById('logsContainer');
            if (logsContainer) {
                logsContainer.innerHTML = '';
            }
            log('🧹 Logs limpiados', 'info');
        });
    }

    const copyLogsBtn = document.getElementById('copyLogsBtn');
    if (copyLogsBtn) {
        copyLogsBtn.addEventListener('click', copyLogsToClipboard);
    }
}

async function init() {
    initEventListeners();
    renderApps();
    updateStats();

    log('🎉 Debloat Universal iniciado', 'success');

    await loadRecommendedList();

    const hasRoot = await detectEnvironment();
    if (hasRoot) {
        await scanApps();
    } else {
        log('ℹ️ Escanea manualmente cuando obtengas acceso root.', 'info');
    }
}

document.addEventListener('DOMContentLoaded', init);

window.setAppAction = setAppAction;
window.uninstallUserApp = uninstallUserApp;
window.debloatConfig = CONFIG;
window.debloatState = STATE;















































