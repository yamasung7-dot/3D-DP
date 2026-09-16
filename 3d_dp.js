BBPlugin.register('3d_dp', {
    title: '3D DP',
    author: 'Yama Sung',
    description: 'Creates physical layered depth parallax geometry from textures or selected base cubes, for Minecraft and generic Blockbench models.',
    version: '0.3.1',
    variant: 'both',
    min_version: '4.10.0',

    onload() {
        try {
            this.action = new Action('3d_dp_generate', {
                name: 'Generate 3D Depth Parallax',
                description: 'Generate physical layered parallax geometry using the original texture plus a grayscale depth scale.',
                icon: 'view_in_ar',
                category: 'edit',
                click: () => safeOpenDialog(),
            });
            this.depth_action = new Action('3d_dp_maps', {
                name: 'Create 3D DP Depth & PBR Maps',
                description: 'Turn the selected texture into a precise grayscale depth scale and optional PBR maps.',
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
    },

    onunload() {
        try {
            if (this.dialog) this.dialog.delete();
            if (this.map_dialog) this.map_dialog.delete();
            if (this.action) this.action.delete();
            if (this.depth_action) this.depth_action.delete();
            this.dialog = null;
            this.map_dialog = null;
            this.action = null;
            this.depth_action = null;
            this.depth_texture = null;
            this.source_texture = null;
            this.pbr_textures = [];
        } catch (error) {
            console.error('[3D DP] Failed during unload:', error);
        }
    },

    action: null,
    depth_action: null,
    dialog: null,
    map_dialog: null,
    depth_texture: null,
    source_texture: null,
    pbr_textures: [],
});

const DIRECTIONS = ['north', 'south', 'east', 'west', 'up', 'down'];
const EPSILON = 1e-6;
const SURFACE_THICKNESS = 0.01;
const MOBILE_MAX_CUBES = 4096;
const DESKTOP_MAX_CUBES = 16384;

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

function safeOpenDialog() {
    try {
        openDialog();
    } catch (error) {
        console.error('[3D DP] Dialog error:', error);
        showError('3D DP could not open its tool window. The plugin is still loaded safely. Try reloading the plugin.');
    }
}

function safeOpenMapDialog() {
    try {
        openMapDialog();
    } catch (error) {
        console.error('[3D DP] Map dialog error:', error);
        showError('3D DP could not open the depth-map tool. The plugin is still loaded safely. Try reloading the plugin.');
    }
}

function showError(message) {
    if (typeof Blockbench !== 'undefined' && Blockbench.showMessageBox) {
        Blockbench.showMessageBox({ title: '3D DP', message, icon: 'error' });
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
    // Rec. 709 luminance gives the depth tool a continuous 0..1 grayscale scale.
    return ((0.2126 * r) + (0.7152 * g) + (0.0722 * b)) / 255;
}

function getDepthFromNormalized(normalized, maxOutward, maxInward) {
    return (normalized * maxOutward) - ((1 - normalized) * maxInward);
}

function getDepthFromPixel(r, g, b, maxOutward, maxInward) {
    return getDepthFromNormalized(getLuminance(r, g, b), maxOutward, maxInward);
}

function makeUV(u, v) {
    return [u, v, u + 1, v + 1];
}

function makePixelCube(x, y, zFrom, zTo, cellW, cellH, uvX, uvY, texture, group, name) {
    let minZ = Math.min(zFrom, zTo);
    let maxZ = Math.max(zFrom, zTo);
    if (maxZ - minZ < SURFACE_THICKNESS) maxZ = minZ + SURFACE_THICKNESS;
    const uvs = makeUV(uvX, uvY);
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

function optimizeHiddenFaces(cubes) {
    const grid = new Map();
    for (const item of cubes) grid.set(item.key, item.cube);
    let disabled = 0;

    function disableIfCovered(cube, direction, neighbor) {
        if (!neighbor) return;
        let covered = false;
        if (direction === 'east') {
            covered = sameNumber(cube.to[0], neighbor.from[0]) && sameRange(cube.from[1], cube.to[1], neighbor.from[1], neighbor.to[1]) && sameRange(cube.from[2], cube.to[2], neighbor.from[2], neighbor.to[2]);
        } else if (direction === 'west') {
            covered = sameNumber(cube.from[0], neighbor.to[0]) && sameRange(cube.from[1], cube.to[1], neighbor.from[1], neighbor.to[1]) && sameRange(cube.from[2], cube.to[2], neighbor.from[2], neighbor.to[2]);
        } else if (direction === 'up') {
            covered = sameNumber(cube.from[1], neighbor.to[1]) && sameRange(cube.from[0], cube.to[0], neighbor.from[0], neighbor.to[0]) && sameRange(cube.from[2], cube.to[2], neighbor.from[2], neighbor.to[2]);
        } else if (direction === 'down') {
            covered = sameNumber(cube.to[1], neighbor.from[1]) && sameRange(cube.from[0], cube.to[0], neighbor.from[0], neighbor.to[0]) && sameRange(cube.from[2], cube.to[2], neighbor.from[2], neighbor.to[2]);
        }
        if (covered && cube.faces[direction].enabled) {
            cube.faces[direction].enabled = false;
            disabled++;
        }
    }

    for (const item of cubes) {
        const [x, y] = item.key.split(',').map(Number);
        const cube = item.cube;
        disableIfCovered(cube, 'east', grid.get(`${x + 1},${y}`));
        disableIfCovered(cube, 'west', grid.get(`${x - 1},${y}`));
        disableIfCovered(cube, 'down', grid.get(`${x},${y + 1}`));
        disableIfCovered(cube, 'up', grid.get(`${x},${y - 1}`));
    }
    return disabled;
}

function makeTextureFromCanvas(name, canvas, channel) {
    const texture = new Texture({ name, width: canvas.width, height: canvas.height, uv_width: canvas.width, uv_height: canvas.height });
    texture.fromDataURL(canvas.toDataURL('image/png')).add();
    if (channel) texture.pbr_channel = channel;
    return texture;
}

function createDepthScaleTexture(width, height, data) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const output = ctx.createImageData(width, height);
    for (let i = 0; i < data.length; i += 4) {
        const value = Math.round(getLuminance(data[i], data[i + 1], data[i + 2]) * 255);
        output.data[i] = value;
        output.data[i + 1] = value;
        output.data[i + 2] = value;
        output.data[i + 3] = data[i + 3];
    }
    ctx.putImageData(output, 0, 0);
    return makeTextureFromCanvas('3D DP Depth Scale', canvas, 'height');
}

function createPBRMaps(width, height, data) {
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
        return getLuminance(data[i], data[i + 1], data[i + 2]);
    }

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const left = sample(x - 1, y);
            const right = sample(x + 1, y);
            const up = sample(x, y - 1);
            const down = sample(x, y + 1);
            const nx = -(right - left);
            const ny = -(down - up);
            const nz = 1;
            const length = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            normal.data[i] = Math.round(((nx / length) * 0.5 + 0.5) * 255);
            normal.data[i + 1] = Math.round(((ny / length) * 0.5 + 0.5) * 255);
            normal.data[i + 2] = Math.round(((nz / length) * 0.5 + 0.5) * 255);
            normal.data[i + 3] = data[i + 3];
            // MER packing: Red = metallic, Green = emissive, Blue = roughness.
            // Metallic is deliberately 0 because ordinary color pixels cannot reliably identify metal.
            mer.data[i] = 0;
            mer.data[i + 1] = 0;
            mer.data[i + 2] = 128;
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

function prepareDepthMaps(includePBR) {
    const source = getSourceTexture(null);
    if (!source) {
        showError('Select the original texture first. 3D DP will keep that original texture for the final model.');
        return;
    }
    const pixelData = getPixelData(source.texture);
    if (!pixelData) {
        showError('The selected texture could not be read as pixel data.');
        return;
    }

    const { width, height, data } = pixelData;
    if (width * height > (isMobile() ? 262144 : 1048576)) {
        showError('This texture is too large for the mobile-safe map generator. Use a smaller texture.');
        return;
    }

    try {
        const depthTexture = createDepthScaleTexture(width, height, data);
        if (!depthTexture) throw new Error('Could not create the depth scale texture.');
        const plugin = getPlugin();
        if (plugin) {
            plugin.depth_texture = depthTexture;
            plugin.source_texture = source.texture;
            plugin.pbr_textures = [];
        }
        const created = ['depth scale'];
        if (includePBR) {
            const pbrMaps = createPBRMaps(width, height, data);
            if (plugin) plugin.pbr_textures = pbrMaps;
            created.push('normal', 'packed MER (metallic/emissive/roughness)');
        }
        // Keep the original color texture selected so the workflow naturally switches back to it.
        Texture.selected = source.texture;
        Blockbench.showQuickMessage(`3D DP: created ${created.join(', ')}. Original texture remains the color texture and the grayscale depth scale is stored for generation.`);
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

function createParallax(maxOutward, maxInward, useGeneratedDepth) {
    const baseCube = getSelectedBaseCube();
    const source = getSourceTexture(baseCube);
    if (!source) {
        showError('Select a texture, or select exactly one cube that has a texture on one of its faces.');
        return;
    }
    const pixelData = getPixelData(source.texture);
    if (!pixelData) {
        showError('The selected texture could not be read as pixel data.');
        return;
    }

    const depthTexture = getDepthTextureForGeneration(source.texture, useGeneratedDepth);
    const depthData = depthTexture ? getPixelData(depthTexture) : pixelData;
    const { width, height, data } = pixelData;
    if (!depthData || depthData.width !== width || depthData.height !== height) {
        showError('The generated depth scale does not match the original texture. Create the depth scale again from the same texture.');
        return;
    }

    const cubeLimit = getCubeLimit();
    const opaquePixels = [];
    for (let py = 0; py < height; py++) {
        for (let px = 0; px < width; px++) {
            if (data[((py * width + px) * 4) + 3] !== 0) opaquePixels.push([px, py]);
        }
    }
    if (opaquePixels.length > cubeLimit) {
        Blockbench.showMessageBox({
            title: '3D DP — Safety Limit',
            message: `${isMobile() ? 'Mobile' : 'Desktop'} safety limit: this texture would create ${opaquePixels.length} pixel cubes, but the current limit is ${cubeLimit}. No geometry was created.`,
            icon: 'warning',
        });
        return;
    }

    let originX = 0;
    let originY = 0;
    let baseZ = 0;
    let cellW = 1;
    let cellH = 1;
    if (baseCube) {
        const cubeWidth = baseCube.to[0] - baseCube.from[0];
        const cubeHeight = baseCube.to[1] - baseCube.from[1];
        originX = baseCube.from[0];
        originY = baseCube.from[1];
        baseZ = baseCube.from[2];
        cellW = cubeWidth / width;
        cellH = cubeHeight / height;
    } else {
        originX = -(width / 2);
        originY = -(height / 2);
        baseZ = 0;
    }

    Undo.initEdit({ outliner: true, elements: true, selection: true });
    let group = null;
    try {
        group = new Group({
            name: '3D DP Parallax',
            origin: [originX, originY, baseZ],
            rotation: [0, 0, 0],
            autouv: 0,
            shade: false,
            export: true,
            visibility: true,
        }).init().addTo('root');

        if (baseCube && source.direction === 'north') baseCube.faces.north.enabled = false;

        const cubes = [];
        const textureRef = source.texture.uuid || source.texture.id;
        for (const [px, py] of opaquePixels) {
            const i = (py * width + px) * 4;
            const depthValue = getLuminance(depthData.data[i], depthData.data[i + 1], depthData.data[i + 2]);
            const depth = getDepthFromNormalized(depthValue, maxOutward, maxInward);
            const z0 = baseZ - Math.max(depth, 0);
            const z1 = baseZ + Math.max(-depth, 0);
            const x = originX + (px * cellW);
            const y = originY + (py * cellH);
            const cube = makePixelCube(x, y, z0, z1, cellW, cellH, px, py, textureRef, group, `px_${px}_${py}`);
            cubes.push({ cube, key: `${px},${py}` });
        }

        const disabled = optimizeHiddenFaces(cubes);
        group.select();
        Undo.finishEdit('Generate 3D Depth Parallax', { outliner: true, elements: true, selection: true });
        Blockbench.showQuickMessage(`3D DP: generated ${cubes.length} pixel layers, removed ${disabled} hidden faces, using ${useGeneratedDepth && depthTexture ? 'the stored grayscale depth scale' : 'live grayscale from the original texture'}. Original texture retained.`);
    } catch (error) {
        Undo.cancelEdit(true);
        if (group) group.remove();
        console.error('[3D DP]', error);
        showError(String(error && error.message ? error.message : error));
    }
}

function openDialog() {
    const baseCube = getSelectedBaseCube();
    const source = getSourceTexture(baseCube);
    const plugin = getPlugin();
    const hasDepth = Boolean(plugin && plugin.depth_texture && plugin.source_texture === (source && source.texture));
    const selectedTextureName = source && source.texture ? source.texture.name : 'No texture selected';
    const mobileText = isMobile() ? `Android/mobile safety limit: ${MOBILE_MAX_CUBES} pixel cubes.` : `Desktop safety limit: ${DESKTOP_MAX_CUBES} pixel cubes.`;
    const dialog = new Dialog('3d_dp_dialog', {
        title: '3D DP — Physical Layered Parallax',
        width: isMobile() ? 360 : 430,
        form: {
            max_outward: { type: 'number', label: 'Max Outward Extrusion (pixels)', value: 2, min: 0, max: 16, step: 0.1 },
            max_inward: { type: 'number', label: 'Max Inward Carving (pixels)', value: 2, min: 0, max: 16, step: 0.1 },
            use_depth_scale: { type: 'checkbox', label: `Use generated grayscale depth scale${hasDepth ? '' : ' (create one first)'}`, value: hasDepth },
            source_info: { type: 'info', text: `Original texture: ${selectedTextureName}<br>${mobileText}<br>Bright = outward, dark = inward, mid-gray = base plane.<br>The original color texture is used on the generated geometry.` },
        },
        onConfirm(form) {
            const outward = clamp(Number(form.max_outward) || 0, 0, 16);
            const inward = clamp(Number(form.max_inward) || 0, 0, 16);
            createParallax(outward, inward, Boolean(form.use_depth_scale));
        },
    });
    if (plugin) plugin.dialog = dialog;
    dialog.show();
}

function openMapDialog() {
    const source = getSourceTexture(null);
    const name = source && source.texture ? source.texture.name : 'No texture selected';
    const dialog = new Dialog('3d_dp_maps_dialog', {
        title: '3D DP — Depth Scale & PBR Maps',
        width: isMobile() ? 360 : 430,
        form: {
            pbr: { type: 'checkbox', label: 'Also create Normal + packed MER maps', value: true },
            info: { type: 'info', text: `Source: ${name}<br><br>3D DP converts the source to a full 256-level grayscale depth scale using Rec. 709 luminance. White is the maximum outward side of the scale, black is the maximum inward side, and middle gray is the base plane.<br><br>The depth map is stored for the generator. Your original color texture remains selected and is used on the final geometry.` },
        },
        onConfirm(form) {
            prepareDepthMaps(Boolean(form.pbr));
        },
    });
    const plugin = getPlugin();
    if (plugin) plugin.map_dialog = dialog;
    dialog.show();
}
