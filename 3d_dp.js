BBPlugin.register('3d_dp', {
    title: '3D DP',
    author: 'Yama Sung',
    description: 'Creates physical layered depth parallax geometry from textures or selected base cubes, for Minecraft and generic Blockbench models.',
    version: '0.5.0',
    variant: 'both',
    min_version: '4.10.0',

    onload() {
        try {
            this.action = new Action('3d_dp_generate', {
                name: 'Generate 3D Depth Parallax',
                description: 'Generate physical layered parallax geometry from the original color texture and depth controls.',
                icon: 'view_in_ar',
                category: 'edit',
                click: () => safeOpenDialog(),
            });
            this.depth_action = new Action('3d_dp_maps', {
                name: 'Create 3D DP Depth & PBR Maps',
                description: 'Create a grayscale depth scale plus optional normal and packed MER maps.',
                icon: 'texture',
                category: 'edit',
                click: () => safeOpenMapDialog(),
            });
        } catch (error) {
            console.error('[3D DP] Failed to create actions:', error);
        }
        this.dialog = null;
        this.map_dialog = null;
        this.depth_texture = null;
        this.source_texture = null;
        this.pbr_textures = [];
        this.settings = {};
    },

    onunload() {
        try {
            if (this.dialog) this.dialog.delete();
            if (this.map_dialog) this.map_dialog.delete();
            if (this.action) this.action.delete();
            if (this.depth_action) this.depth_action.delete();
        } catch (error) {
            console.error('[3D DP] Failed during unload:', error);
        }
        this.dialog = null;
        this.map_dialog = null;
        this.action = null;
        this.depth_action = null;
        this.depth_texture = null;
        this.source_texture = null;
        this.pbr_textures = [];
        this.settings = {};
    },

    action: null,
    depth_action: null,
    dialog: null,
    map_dialog: null,
    depth_texture: null,
    source_texture: null,
    pbr_textures: [],
    settings: {},
});

const DIRECTIONS = ['north', 'south', 'east', 'west', 'up', 'down'];
const EPSILON = 1e-6;
const SURFACE_THICKNESS = 0.01;
const MOBILE_MAX_CUBES = 4096;
const DESKTOP_MAX_CUBES = 16384;
const MOBILE_MAX_MAP_PIXELS = 262144;
const DESKTOP_MAX_MAP_PIXELS = 1048576;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function isMobile() {
    return Boolean(typeof Blockbench !== 'undefined' && Blockbench.isMobile);
}

function getCubeLimit() {
    return isMobile() ? MOBILE_MAX_CUBES : DESKTOP_MAX_CUBES;
}

function getPlugin() {
    return Plugins.registered['3d_dp'];
}

function showError(message) {
    if (typeof Blockbench !== 'undefined' && Blockbench.showMessageBox) {
        Blockbench.showMessageBox({ title: '3D DP', message, icon: 'error' });
    }
}

function safeOpenDialog() {
    try {
        openDialog();
    } catch (error) {
        console.error('[3D DP] Dialog error:', error);
        showError('3D DP could not open its tool window. Try reloading the plugin.');
    }
}

function safeOpenMapDialog() {
    try {
        openMapDialog();
    } catch (error) {
        console.error('[3D DP] Map dialog error:', error);
        showError('3D DP could not open the depth-map tool. Try reloading the plugin.');
    }
}

function getSelectedBaseCube() {
    const selected = Cube.selected || [];
    return selected.length === 1 ? selected[0] : null;
}

function getSourceTexture(baseCube) {
    if (baseCube) {
        for (const direction of DIRECTIONS) {
            const face = baseCube.faces[direction];
            if (!face) continue;
            const texture = face.getTexture ? face.getTexture() : null;
            if (texture && texture.canvas) return { texture, direction };
        }
    }
    const texture = Texture.selected;
    return texture && texture.canvas ? { texture, direction: null } : null;
}

function getPixelData(texture) {
    const source = texture.getActiveCanvas ? texture.getActiveCanvas() : texture;
    const canvas = source.canvas || texture.canvas;
    if (!canvas) return null;
    const width = canvas.width || texture.width;
    const height = canvas.height || texture.height;
    if (!width || !height) return null;
    const ctx = source.ctx || texture.ctx || canvas.getContext('2d');
    if (!ctx) return null;
    try {
        return { width, height, data: ctx.getImageData(0, 0, width, height).data };
    } catch (error) {
        console.error('[3D DP] Pixel read failed:', error);
        return null;
    }
}

function getLuminance(r, g, b) {
    return ((0.2126 * r) + (0.7152 * g) + (0.0722 * b)) / 255;
}

function applyDepthCurve(value, curve, midpoint) {
    value = clamp(value, 0, 1);
    midpoint = clamp(midpoint, 0.001, 0.999);
    if (curve === 'soft') value = Math.sqrt(value);
    if (curve === 'strong') value = value * value;
    if (curve === 'contrast') value = value < 0.5 ? value * 0.5 : 0.5 + (value - 0.5) * 1.5;
    if (value >= midpoint) return 0.5 + ((value - midpoint) / (1 - midpoint)) * 0.5;
    return ((value / midpoint) * 0.5);
}

function getDepthFromNormalized(normalized, maxOutward, maxInward, curve, midpoint) {
    const centered = applyDepthCurve(normalized, curve, midpoint);
    return (centered * maxOutward) - ((1 - centered) * maxInward);
}

function makeUV(u, v, w, h) {
    return [u, v, u + w, v + h];
}

function makePixelCube(x, y, zFrom, zTo, cellW, cellH, uvX, uvY, uvW, uvH, texture, group, name) {
    let minZ = Math.min(zFrom, zTo);
    let maxZ = Math.max(zFrom, zTo);
    if (maxZ - minZ < SURFACE_THICKNESS) maxZ = minZ + SURFACE_THICKNESS;
    const uvs = makeUV(uvX, uvY, uvW, uvH);
    const faces = {};
    for (const direction of DIRECTIONS) {
        faces[direction] = { uv: [...uvs], texture, rotation: 0, enabled: true };
    }
    return new Cube({
        name,
        from: [x, y, minZ],
        to: [x + cellW, y + cellH, maxZ],
        box_uv: false,
        autouv: 0,
        shade: false,
        faces,
        export: true,
    }).init().addTo(group);
}

function sameNumber(a, b) {
    return Math.abs(a - b) <= EPSILON;
}

function sameRange(a0, a1, b0, b1) {
    return sameNumber(a0, b0) && sameNumber(a1, b1);
}

function rectangleCovered(intervals, start, end) {
    if (end <= start + EPSILON) return true;
    intervals.sort((a, b) => a[0] - b[0]);
    let cursor = start;
    for (const interval of intervals) {
        if (interval[1] <= cursor + EPSILON) continue;
        if (interval[0] > cursor + EPSILON) return false;
        cursor = Math.max(cursor, interval[1]);
        if (cursor >= end - EPSILON) return true;
    }
    return cursor >= end - EPSILON;
}

function optimizeHiddenFaces(cubes) {
    const maps = { east: new Map(), west: new Map(), up: new Map(), down: new Map() };
    function add(map, key, item, start, end) {
        if (!map.has(key)) map.set(key, []);
        map.get(key).push([start, end, item]);
    }
    for (const item of cubes) {
        const c = item.cube;
        add(maps.east, `${c.to[0]}|${c.from[2]}|${c.to[2]}`, item, c.from[1], c.to[1]);
        add(maps.west, `${c.from[0]}|${c.from[2]}|${c.to[2]}`, item, c.from[1], c.to[1]);
        add(maps.up, `${c.from[1]}|${c.from[2]}|${c.to[2]}`, item, c.from[0], c.to[0]);
        add(maps.down, `${c.to[1]}|${c.from[2]}|${c.to[2]}`, item, c.from[0], c.to[0]);
    }
    let disabled = 0;
    for (const item of cubes) {
        const c = item.cube;
        const checks = [
            ['east', maps.west, c.to[0], c.from[1], c.to[1]],
            ['west', maps.east, c.from[0], c.from[1], c.to[1]],
            ['up', maps.down, c.from[1], c.from[0], c.to[0]],
            ['down', maps.up, c.to[1], c.from[0], c.to[0]],
        ];
        for (const [direction, map, plane, start, end] of checks) {
            const key = `${plane}|${c.from[2]}|${c.to[2]}`;
            const entries = map.get(key) || [];
            const intervals = entries.filter(entry => entry[2] !== item).map(entry => [entry[0], entry[1]]);
            if (rectangleCovered(intervals, start, end) && c.faces[direction].enabled) {
                c.faces[direction].enabled = false;
                disabled++;
            }
        }
    }
    return disabled;
}

function makeTextureFromCanvas(name, canvas, channel) {
    const texture = new Texture({ name, width: canvas.width, height: canvas.height, uv_width: canvas.width, uv_height: canvas.height });
    texture.fromDataURL(canvas.toDataURL('image/png')).add();
    if (channel) texture.pbr_channel = channel;
    return texture;
}

function createDepthScaleTexture(width, height, data, settings) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const output = ctx.createImageData(width, height);
    for (let i = 0; i < data.length; i += 4) {
        let value = getLuminance(data[i], data[i + 1], data[i + 2]);
        value = applyDepthCurve(value, settings.curve, settings.midpoint);
        if (settings.invert) value = 1 - value;
        const out = Math.round(value * 255);
        output.data[i] = output.data[i + 1] = output.data[i + 2] = out;
        output.data[i + 3] = data[i + 3];
    }
    ctx.putImageData(output, 0, 0);
    return makeTextureFromCanvas('3D DP Depth Scale', canvas, 'height');
}

function createPBRMaps(width, height, data, settings) {
    const normalCanvas = document.createElement('canvas');
    const merCanvas = document.createElement('canvas');
    normalCanvas.width = merCanvas.width = width;
    normalCanvas.height = merCanvas.height = height;
    const nctx = normalCanvas.getContext('2d');
    const mctx = merCanvas.getContext('2d');
    if (!nctx || !mctx) return [];
    const normal = nctx.createImageData(width, height);
    const mer = mctx.createImageData(width, height);
    function sample(px, py) {
        px = clamp(px, 0, width - 1);
        py = clamp(py, 0, height - 1);
        const i = (py * width + px) * 4;
        let v = getLuminance(data[i], data[i + 1], data[i + 2]);
        v = applyDepthCurve(v, settings.curve, settings.midpoint);
        if (settings.invert) v = 1 - v;
        return v;
    }
    const strength = Math.max(0, Number(settings.normal_strength) || 1);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const left = sample(x - 1, y);
            const right = sample(x + 1, y);
            const up = sample(x, y - 1);
            const down = sample(x, y + 1);
            const nx = -(right - left) * strength;
            const ny = -(down - up) * strength;
            const nz = 1;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            normal.data[i] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
            normal.data[i + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
            normal.data[i + 2] = Math.round(((nz / len) * 0.5 + 0.5) * 255);
            normal.data[i + 3] = data[i + 3];
            mer.data[i] = Math.round(clamp(Number(settings.metallic) || 0, 0, 1) * 255);
            mer.data[i + 1] = Math.round(clamp(Number(settings.emissive) || 0, 0, 1) * 255);
            mer.data[i + 2] = Math.round(clamp(Number(settings.roughness) || 0.5, 0, 1) * 255);
            mer.data[i + 3] = data[i + 3];
        }
    }
    nctx.putImageData(normal, 0, 0);
    mctx.putImageData(mer, 0, 0);
    return [
        makeTextureFromCanvas('3D DP Normal', normalCanvas, 'normal'),
        makeTextureFromCanvas('3D DP MER (Metallic/Emissive/Roughness)', merCanvas, 'mer'),
    ];
}

function prepareDepthMaps(form) {
    const source = getSourceTexture(null);
    if (!source) return showError('Select the original color texture first.');
    const pixelData = getPixelData(source.texture);
    if (!pixelData) return showError('The selected texture could not be read as pixel data.');
    const { width, height, data } = pixelData;
    if (width * height > (isMobile() ? MOBILE_MAX_MAP_PIXELS : DESKTOP_MAX_MAP_PIXELS)) {
        return showError('This texture is too large for the mobile-safe map generator. Use a smaller texture.');
    }
    try {
        const settings = {
            curve: form.curve || 'linear',
            midpoint: Number(form.midpoint) || 0.5,
            invert: Boolean(form.invert),
            normal_strength: Number(form.normal_strength) || 1,
            roughness: Number(form.roughness) || 0.5,
            metallic: Number(form.metallic) || 0,
            emissive: Number(form.emissive) || 0,
        };
        const depthTexture = createDepthScaleTexture(width, height, data, settings);
        if (!depthTexture) throw new Error('Could not create the depth scale texture.');
        const plugin = getPlugin();
        if (plugin) {
            plugin.depth_texture = depthTexture;
            plugin.source_texture = source.texture;
            plugin.settings = settings;
            plugin.pbr_textures = Boolean(form.pbr) ? createPBRMaps(width, height, data, settings) : [];
        }
        const count = Boolean(form.pbr) ? 3 : 1;
        Texture.selected = source.texture;
        Blockbench.showQuickMessage(`3D DP: created ${count} map${count === 1 ? '' : 's'}; original color texture remains selected.`);
    } catch (error) {
        console.error('[3D DP] Map generation failed:', error);
        showError(`3D DP could not create the maps: ${error.message || error}`);
    }
}

function getDepthTextureForGeneration(sourceTexture, useGeneratedDepth) {
    const plugin = getPlugin();
    if (useGeneratedDepth && plugin && plugin.depth_texture && plugin.source_texture === sourceTexture) return plugin.depth_texture;
    return null;
}

function getProjectionTransform(direction, baseCube) {
    const from = baseCube ? baseCube.from : [0, 0, 0];
    const to = baseCube ? baseCube.to : [0, 0, 0];
    switch (direction) {
        case 'south': return { origin: [0, 0, to[2]], rotation: [0, 0, 0], flipX: false, flipY: false };
        case 'east': return { origin: [to[0], 0, 0], rotation: [0, 90, 0], flipX: false, flipY: false };
        case 'west': return { origin: [from[0], 0, 0], rotation: [0, -90, 0], flipX: false, flipY: false };
        case 'up': return { origin: [0, to[1], 0], rotation: [-90, 0, 0], flipX: false, flipY: false };
        case 'down': return { origin: [0, from[1], 0], rotation: [90, 0, 0], flipX: false, flipY: false };
        default: return { origin: [0, 0, from[2]], rotation: [0, 180, 0], flipX: false, flipY: false };
    }
}

function createParallax(form) {
    const baseCube = getSelectedBaseCube();
    const source = getSourceTexture(baseCube);
    if (!source) return showError('Select a texture, or select exactly one textured cube.');
    const pixelData = getPixelData(source.texture);
    if (!pixelData) return showError('The selected texture could not be read as pixel data.');
    const depthTexture = getDepthTextureForGeneration(source.texture, Boolean(form.use_depth_scale));
    const depthData = depthTexture ? getPixelData(depthTexture) : pixelData;
    if (!depthData || depthData.width !== pixelData.width || depthData.height !== pixelData.height) {
        return showError('The stored depth scale does not match the original texture. Create it again from the same texture.');
    }
    const width = pixelData.width;
    const height = pixelData.height;
    const data = pixelData.data;
    const ddata = depthData.data;
    const maxOutward = Math.max(0, Number(form.outward) || 0);
    const maxInward = Math.max(0, Number(form.inward) || 0);
    const curve = form.curve || 'linear';
    const midpoint = clamp(Number(form.midpoint) || 0.5, 0.001, 0.999);
    const merge = Boolean(form.merge);
    const smooth = Boolean(form.smooth);
    const threshold = clamp(Number(form.alpha_threshold) || 1, 0, 255);
    const direction = form.direction === 'auto' ? (source.direction || 'north') : (form.direction || source.direction || 'north');
    const limit = getCubeLimit();

    const cells = [];
    const byRow = new Map();
    for (let y = 0; y < height; y++) {
        let run = null;
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (data[i + 3] < threshold) {
                if (run) { byRow.set(`${y}:${run.x}`, run); run = null; }
                continue;
            }
            let value = getLuminance(ddata[i], ddata[i + 1], ddata[i + 2]);
            if (smooth && x > 0 && x < width - 1) {
                const a = getLuminance(ddata[i - 4], ddata[i - 3], ddata[i - 2]);
                const b = getLuminance(ddata[i + 4], ddata[i + 5], ddata[i + 6]);
                value = (value * 2 + a + b) / 4;
            }
            const depth = getDepthFromNormalized(value, maxOutward, maxInward, curve, midpoint);
            if (merge && run && Math.abs(run.depth - depth) <= 0.0001) {
                run.w++;
            } else {
                if (run) cells.push(run);
                run = { x, y, w: 1, h: 1, depth };
            }
        }
        if (run) cells.push(run);
    }

    if (merge && cells.length) {
        const merged = [];
        const lookup = new Map();
        for (const cell of cells) lookup.set(`${cell.x},${cell.y}`, cell);
        const used = new Set();
        for (const cell of cells) {
            const key = `${cell.x},${cell.y}`;
            if (used.has(key)) continue;
            let h = cell.h;
            while (true) {
                let ok = true;
                for (let x = cell.x; x < cell.x + cell.w; x++) {
                    const n = lookup.get(`${x},${cell.y + h}`);
                    if (!n || n.w !== 1 || Math.abs(n.depth - cell.depth) > 0.0001 || used.has(`${x},${cell.y + h}`)) { ok = false; break; }
                }
                if (!ok) break;
                h++;
            }
            for (let yy = cell.y; yy < cell.y + h; yy++) {
                for (let xx = cell.x; xx < cell.x + cell.w; xx++) used.add(`${xx},${yy}`);
            }
            merged.push({ x: cell.x, y: cell.y, w: cell.w, h, depth: cell.depth });
        }
        cells.length = 0;
        cells.push(...merged);
    }

    if (cells.length > limit) {
        return showError(`3D DP estimates ${cells.length} geometry layers, above the ${limit}-cube ${isMobile() ? 'mobile' : 'desktop'} safety limit. Enable Merge Similar Depth Regions or use a smaller texture.`);
    }

    let group = null;
    try {
        Undo.initEdit({ outliner: true, elements: true, selection: true });
        group = new Group({ name: `3D DP ${source.texture.name || 'Texture'}` }).init().addTo(Panels.outliner.root);
        const transform = getProjectionTransform(direction, baseCube);
        group.origin = transform.origin;
        group.rotation = transform.rotation;
        const cellW = baseCube ? Math.abs(baseCube.to[0] - baseCube.from[0]) / width : 1;
        const cellH = baseCube ? Math.abs(baseCube.to[1] - baseCube.from[1]) / height : 1;
        const zBase = 0;
        for (let index = 0; index < cells.length; index++) {
            const cell = cells[index];
            const cube = makePixelCube(cell.x * cellW, cell.y * cellH, zBase, cell.depth, cell.w * cellW, cell.h * cellH, cell.x, cell.y, cell.w, cell.h, source.texture.uuid || source.texture.id, group, `DP_${index}`);
            cells[index].cube = cube;
        }
        const disabled = optimizeHiddenFaces(cells);
        if (baseCube && baseCube.faces[direction]) baseCube.faces[direction].enabled = false;
        group.select();
        Undo.finishEdit('Generate 3D Depth Parallax', { outliner: true, elements: true, selection: true });
        Blockbench.showQuickMessage(`3D DP: generated ${cells.length} layers, removed ${disabled} hidden faces, merged=${merge ? 'on' : 'off'}, projection=${direction}.`);
    } catch (error) {
        Undo.cancelEdit(true);
        if (group) group.remove();
        console.error('[3D DP] Generation failed:', error);
        showError(`3D DP could not generate the model: ${error.message || error}`);
    }
}

function openDialog() {
    const baseCube = getSelectedBaseCube();
    const source = getSourceTexture(baseCube);
    const plugin = getPlugin();
    if (plugin && plugin.dialog) plugin.dialog.delete();
    const saved = plugin ? plugin.settings || {} : {};
    const name = source && source.texture ? source.texture.name : 'No texture selected';
    const defaultDirection = source && (source.direction || baseCube) ? (source.direction || 'auto') : 'auto';
    const dialog = new Dialog({
        id: '3d_dp_generate_dialog',
        title: '3D DP — Generate Physical Parallax',
        width: isMobile() ? 360 : 440,
        form: {
            outward: { type: 'number', label: 'Max outward depth', value: 4, min: 0, max: 64, step: 0.1 },
            inward: { type: 'number', label: 'Max inward depth', value: 4, min: 0, max: 64, step: 0.1 },
            curve: { type: 'select', label: 'Depth curve', options: { linear: 'Linear', soft: 'Soft highlights', strong: 'Strong center', contrast: 'High contrast' }, value: saved.curve || 'linear' },
            midpoint: { type: 'number', label: 'Midpoint (0–1)', value: saved.midpoint || 0.5, min: 0.05, max: 0.95, step: 0.05 },
            invert: { type: 'checkbox', label: 'Invert depth', value: Boolean(saved.invert) },
            smooth: { type: 'checkbox', label: 'Smooth depth sampling', value: true },
            alpha_threshold: { type: 'number', label: 'Transparency threshold (0–255)', value: 1, min: 0, max: 255, step: 1 },
            merge: { type: 'checkbox', label: 'Merge equal-depth regions', value: true },
            direction: { type: 'select', label: 'Projection face', options: { auto: 'Auto / selected face', north: 'North', south: 'South', east: 'East', west: 'West', up: 'Up', down: 'Down' }, value: defaultDirection },
            use_depth_scale: { type: 'checkbox', label: 'Use stored grayscale depth scale', value: Boolean(plugin && plugin.depth_texture && plugin.source_texture === (source && source.texture)) },
            info: { type: 'info', text: `Source: ${name}<br><br>Bright pixels become outward depth, dark pixels become inward depth, and transparent pixels are skipped. The original color texture is used on the generated geometry.` },
        },
        onConfirm(form) {
            createParallax(form);
        },
    });
    if (plugin) plugin.dialog = dialog;
    dialog.show();
}

function openMapDialog() {
    const source = getSourceTexture(null);
    const plugin = getPlugin();
    if (plugin && plugin.map_dialog) plugin.map_dialog.delete();
    const name = source && source.texture ? source.texture.name : 'No texture selected';
    const saved = plugin ? plugin.settings || {} : {};
    const dialog = new Dialog({
        id: '3d_dp_map_dialog',
        title: '3D DP — Depth Scale & PBR Maps',
        width: isMobile() ? 360 : 430,
        form: {
            curve: { type: 'select', label: 'Depth curve', options: { linear: 'Linear', soft: 'Soft highlights', strong: 'Strong center', contrast: 'High contrast' }, value: saved.curve || 'linear' },
            midpoint: { type: 'number', label: 'Midpoint (0–1)', value: saved.midpoint || 0.5, min: 0.05, max: 0.95, step: 0.05 },
            invert: { type: 'checkbox', label: 'Invert depth scale', value: Boolean(saved.invert) },
            pbr: { type: 'checkbox', label: 'Also create Normal + packed MER', value: true },
            normal_strength: { type: 'number', label: 'Normal strength', value: saved.normal_strength || 1, min: 0, max: 8, step: 0.1 },
            roughness: { type: 'number', label: 'MER roughness (0–1)', value: saved.roughness ?? 0.5, min: 0, max: 1, step: 0.05 },
            metallic: { type: 'number', label: 'MER metallic (0–1)', value: saved.metallic || 0, min: 0, max: 1, step: 0.05 },
            emissive: { type: 'number', label: 'MER emissive (0–1)', value: saved.emissive || 0, min: 0, max: 1, step: 0.05 },
            info: { type: 'info', text: `Source: ${name}<br><br>The depth scale is grayscale and marked as a height map. Normal is generated from its gradient. MER packs metallic, emissive and roughness into one map. The original color texture remains the color texture.` },
        },
        onConfirm(form) {
            prepareDepthMaps(form);
        },
    });
    if (plugin) plugin.map_dialog = dialog;
    dialog.show();
}
