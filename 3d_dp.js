BBPlugin.register('3d_dp', {
    title: '3D DP',
    author: 'Yama Sung',
    description: 'Creates physical layered depth parallax geometry from textures or selected base cubes, for Minecraft and generic Blockbench models.',
    version: '0.2.0',
    variant: 'both',
    min_version: '4.10.0',

    onload() {
        try {
            this.action = new Action('3d_dp_generate', {
                name: 'Generate 3D Depth Parallax',
                description: 'Generate physical layered parallax geometry from a texture or selected base cube.',
                icon: 'view_in_ar',
                category: 'edit',
                click: () => safeOpenDialog(),
            });
        } catch (error) {
            console.error('[3D DP] Failed to create action:', error);
        }
        this.dialog = null;
    },

    onunload() {
        try {
            if (this.dialog) {
                this.dialog.delete();
                this.dialog = null;
            }
            if (this.action) {
                this.action.delete();
                this.action = null;
            }
        } catch (error) {
            console.error('[3D DP] Failed during unload:', error);
        }
    },

    action: null,
    dialog: null,
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

function safeOpenDialog() {
    try {
        openDialog();
    } catch (error) {
        console.error('[3D DP] Dialog error:', error);
        if (typeof Blockbench !== 'undefined' && Blockbench.showMessageBox) {
            Blockbench.showMessageBox({
                title: '3D DP',
                message: '3D DP could not open its tool window. The plugin is still loaded safely. Please reload the plugin and try again.',
                icon: 'error',
            });
        }
    }
}

function getSelectedBaseCube() {
    const selected = Cube.selected || [];
    return selected.length === 1 ? selected[0] : null;
}

function getSourceTexture(baseCube) {
    if (baseCube) {
        const preferred = ['north', 'south', 'east', 'west', 'up', 'down'];
        for (const direction of preferred) {
            const face = baseCube.faces[direction];
            if (!face) continue;
            const texture = face.getTexture ? face.getTexture() : null;
            if (texture && texture.canvas) return { texture, direction };
        }
    }

    const texture = Texture.selected;
    if (texture && texture.canvas) return { texture, direction: null };
    return null;
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

    return {
        width,
        height,
        data: ctx.getImageData(0, 0, width, height).data,
    };
}

function getDepthFromPixel(r, g, b, maxOutward, maxInward) {
    // Bright pixels become highlights; dark pixels become recesses.
    const luminance = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
    const normalized = luminance / 255;
    const outward = Math.round(normalized * maxOutward);
    const inward = Math.round((1 - normalized) * maxInward);
    return outward - inward;
}

function makeUV(u, v) {
    // Each face samples its source texel rather than the whole texture.
    return [u, v, u + 1, v + 1];
}

function makePixelCube(x, y, zFrom, zTo, cellW, cellH, uvX, uvY, texture, group, name) {
    let minZ = Math.min(zFrom, zTo);
    let maxZ = Math.max(zFrom, zTo);
    if (maxZ - minZ < SURFACE_THICKNESS) maxZ = minZ + SURFACE_THICKNESS;

    const uvs = makeUV(uvX, uvY);
    const faces = {};
    for (const direction of DIRECTIONS) {
        faces[direction] = {
            uv: [...uvs],
            texture,
            rotation: 0,
            enabled: true,
        };
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
            covered = sameNumber(cube.to[0], neighbor.from[0])
                && sameRange(cube.from[1], cube.to[1], neighbor.from[1], neighbor.to[1])
                && sameRange(cube.from[2], cube.to[2], neighbor.from[2], neighbor.to[2]);
        } else if (direction === 'west') {
            covered = sameNumber(cube.from[0], neighbor.to[0])
                && sameRange(cube.from[1], cube.to[1], neighbor.from[1], neighbor.to[1])
                && sameRange(cube.from[2], cube.to[2], neighbor.from[2], neighbor.to[2]);
        } else if (direction === 'up') {
            covered = sameNumber(cube.from[1], neighbor.to[1])
                && sameRange(cube.from[0], cube.to[0], neighbor.from[0], neighbor.to[0])
                && sameRange(cube.from[2], cube.to[2], neighbor.from[2], neighbor.to[2]);
        } else if (direction === 'down') {
            covered = sameNumber(cube.to[1], neighbor.from[1])
                && sameRange(cube.from[0], cube.to[0], neighbor.from[0], neighbor.to[0])
                && sameRange(cube.from[2], cube.to[2], neighbor.from[2], neighbor.to[2]);
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

function createDepthHeightMap(width, height, data, maxOutward, maxInward) {
    if (typeof Texture !== 'function') return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const output = ctx.createImageData(width, height);
    const maxDepth = Math.max(1, maxOutward, maxInward);
    for (let py = 0; py < height; py++) {
        for (let px = 0; px < width; px++) {
            const i = (py * width + px) * 4;
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const a = data[i + 3];
            const depth = getDepthFromPixel(r, g, b, maxOutward, maxInward);
            const normalized = clamp((depth + maxDepth) / (maxDepth * 2), 0, 1);
            const value = Math.round(normalized * 255);
            output.data[i] = value;
            output.data[i + 1] = value;
            output.data[i + 2] = value;
            output.data[i + 3] = a;
        }
    }
    ctx.putImageData(output, 0, 0);

    const heightTexture = new Texture({
        name: '3D DP Depth Height',
        width,
        height,
        uv_width: width,
        uv_height: height,
    });
    heightTexture.fromDataURL(canvas.toDataURL('image/png')).add();
    heightTexture.pbr_channel = 'height';
    heightTexture.render_mode = 'default';
    return heightTexture;
}

function createParallax(maxOutward, maxInward, storeHeightMap) {
    const baseCube = getSelectedBaseCube();
    const source = getSourceTexture(baseCube);
    if (!source) {
        Blockbench.showMessageBox({
            title: '3D DP',
            message: 'Select a texture, or select exactly one cube that has a texture on one of its faces.',
            icon: 'error',
        });
        return;
    }

    const pixelData = getPixelData(source.texture);
    if (!pixelData) {
        Blockbench.showMessageBox({
            title: '3D DP',
            message: 'The selected texture could not be read as pixel data.',
            icon: 'error',
        });
        return;
    }

    const { width, height, data } = pixelData;
    const cubeLimit = getCubeLimit();
    const opaquePixels = [];
    for (let py = 0; py < height; py++) {
        for (let px = 0; px < width; px++) {
            const alpha = data[((py * width + px) * 4) + 3];
            if (alpha !== 0) opaquePixels.push([px, py]);
        }
    }

    if (opaquePixels.length > cubeLimit) {
        Blockbench.showMessageBox({
            title: '3D DP — Safety Limit',
            message: `${isMobile() ? 'Mobile' : 'Desktop'} safety limit: this texture would create ${opaquePixels.length} pixel cubes, but the current limit is ${cubeLimit}. Use a smaller texture or a texture with more transparency. No geometry was created.`,
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
    let heightTexture = null;
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

        if (baseCube && source.direction === 'north') {
            baseCube.faces.north.enabled = false;
        }

        const cubes = [];
        const textureRef = source.texture.uuid || source.texture.id;

        for (const [px, py] of opaquePixels) {
            const i = (py * width + px) * 4;
            const depth = getDepthFromPixel(data[i], data[i + 1], data[i + 2], maxOutward, maxInward);
            const z0 = baseZ - Math.max(depth, 0);
            const z1 = baseZ + Math.max(-depth, 0);
            const x = originX + (px * cellW);
            const y = originY + (py * cellH);

            const cube = makePixelCube(
                x, y, z0, z1, cellW, cellH, px, py,
                textureRef, group, `px_${px}_${py}`,
            );
            cubes.push({ cube, key: `${px},${py}` });
        }

        const disabled = optimizeHiddenFaces(cubes);

        if (storeHeightMap) {
            heightTexture = createDepthHeightMap(width, height, data, maxOutward, maxInward);
        }

        group.select();
        Undo.finishEdit('Generate 3D Depth Parallax', { outliner: true, elements: true, selection: true });
        Blockbench.showQuickMessage(
            `3D DP: generated ${cubes.length} pixel layers, removed ${disabled} hidden faces${heightTexture ? ', stored a PBR height map' : ''}.`,
        );
    } catch (error) {
        Undo.cancelEdit(true);
        if (group) group.remove();
        if (heightTexture && heightTexture.remove) heightTexture.remove(true);
        console.error('[3D DP]', error);
        Blockbench.showMessageBox({
            title: '3D DP Error',
            message: String(error && error.message ? error.message : error),
            icon: 'error',
        });
    }
}

function openDialog() {
    const baseCube = getSelectedBaseCube();
    const source = getSourceTexture(baseCube);
    const selectedTextureName = source && source.texture ? source.texture.name : 'No texture selected';
    const mobileText = isMobile()
        ? `Android/mobile safety limit: ${MOBILE_MAX_CUBES} pixel cubes per operation.`
        : `Desktop safety limit: ${DESKTOP_MAX_CUBES} pixel cubes per operation.`;

    const dialog = new Dialog('3d_dp_dialog', {
        title: '3D DP — Physical Layered Parallax',
        width: 430,
        form: {
            max_outward: {
                type: 'number',
                label: 'Max Outward Extrusion (pixels)',
                value: 2,
                min: 0,
                max: 16,
                step: 1,
            },
            max_inward: {
                type: 'number',
                label: 'Max Inward Carving (pixels)',
                value: 2,
                min: 0,
                max: 16,
                step: 1,
            },
            store_height: {
                type: 'checkbox',
                label: 'Store depth as PBR height map',
                value: true,
            },
            source_info: {
                type: 'info',
                text: `Source: ${selectedTextureName}<br>${mobileText}<br>Works with Minecraft and Generic Model projects.`,
            },
        },
        onConfirm(form) {
            const outward = clamp(Math.round(Number(form.max_outward) || 0), 0, 16);
            const inward = clamp(Math.round(Number(form.max_inward) || 0), 0, 16);
            createParallax(outward, inward, Boolean(form.store_height));
        },
    });

    const plugin = Plugins.registered['3d_dp'];
    if (plugin) plugin.dialog = dialog;
    dialog.show();
}
