BBPlugin.register('3d_dp', {
    title: '3D DP — Depth Parallax',
    author: 'Yama Sung',
    icon: 'view_in_ar',
    description: 'Creates physical layered depth-parallax geometry from textures or selected base cubes, with depth and PBR map tools.',
    version: '0.7.0',
    variant: 'both',
    min_version: '4.10.0',
    onload() {
        try {
            this.action = new Action('3d_dp_generate', {
                name: '3D DP — Generate Depth Parallax', icon: 'view_in_ar', category: 'edit',
                click: () => safeOpenDialog()
            });
            this.depth_action = new Action('3d_dp_maps', {
                name: '3D DP — Create Depth & PBR Maps', icon: 'texture', category: 'edit',
                click: () => safeOpenMapDialog()
            });
            if (MenuBar && MenuBar.menus && MenuBar.menus.tools) {
                MenuBar.menus.tools.addAction(this.action);
                MenuBar.menus.tools.addAction(this.depth_action);
            }
        } catch (e) { console.error('[3D DP] action setup failed', e); }
        this.dialog = null; this.map_dialog = null; this.depth_texture = null;
        this.source_texture = null; this.pbr_textures = []; this.settings = {};
    },
    onunload() {
        try { if (this.dialog) this.dialog.delete(); if (this.map_dialog) this.map_dialog.delete(); if (this.action) this.action.delete(); if (this.depth_action) this.depth_action.delete(); } catch (e) { console.error('[3D DP] unload failed', e); }
        this.dialog = null; this.map_dialog = null; this.action = null; this.depth_action = null;
        this.depth_texture = null; this.source_texture = null; this.pbr_textures = []; this.settings = {};
    },
    action: null, depth_action: null, dialog: null, map_dialog: null,
    depth_texture: null, source_texture: null, pbr_textures: [], settings: {}
});

const DIRECTIONS = ['north','south','east','west','up','down'];
const EPSILON = 1e-6;
const SURFACE_THICKNESS = 0.01;
const MOBILE_MAX_CUBES = 4096;
const DESKTOP_MAX_CUBES = 16384;
const MOBILE_MAX_MAP_PIXELS = 262144;
const DESKTOP_MAX_MAP_PIXELS = 1048576;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function mobile() { return !!(typeof Blockbench !== 'undefined' && Blockbench.isMobile); }
function cubeLimit() { return mobile() ? MOBILE_MAX_CUBES : DESKTOP_MAX_CUBES; }
function plugin() { return Plugins.registered['3d_dp']; }
function errorBox(message) { if (typeof Blockbench !== 'undefined' && Blockbench.showMessageBox) Blockbench.showMessageBox({title:'3D DP',message,icon:'error'}); }
function safeOpenDialog() { try { openDialog(); } catch(e) { console.error(e); errorBox('3D DP could not open its tool window. Try reloading the plugin.'); } }
function safeOpenMapDialog() { try { openMapDialog(); } catch(e) { console.error(e); errorBox('3D DP could not open the map tool. Try reloading the plugin.'); } }

function selectedCube() { const s = Cube.selected || []; return s.length === 1 ? s[0] : null; }
function sourceTexture(base) {
    if (base) for (const d of DIRECTIONS) {
        const f = base.faces[d]; const t = f && f.getTexture ? f.getTexture() : null;
        if (t && t.canvas) return {texture:t,direction:d};
    }
    const t = Texture.selected;
    return t && t.canvas ? {texture:t,direction:null} : null;
}
function pixels(texture) {
    const active = texture.getActiveCanvas ? texture.getActiveCanvas() : texture;
    const canvas = active.canvas || texture.canvas; if (!canvas) return null;
    const w = canvas.width || texture.width, h = canvas.height || texture.height;
    const ctx = active.ctx || texture.ctx || canvas.getContext('2d');
    if (!w || !h || !ctx) return null;
    try { return {width:w,height:h,data:ctx.getImageData(0,0,w,h).data}; } catch(e) { console.error(e); return null; }
}
function lum(r,g,b) { return (0.2126*r + 0.7152*g + 0.0722*b)/255; }
function curve(v, mode, midpoint) {
    v=clamp(v,0,1); midpoint=clamp(midpoint,0.001,0.999);
    if(mode==='soft') v=Math.sqrt(v); else if(mode==='strong') v=v*v;
    else if(mode==='contrast') v=v<0.5?v*0.5:0.5+(v-0.5)*1.5;
    return v>=midpoint ? 0.5+(v-midpoint)/(1-midpoint)*0.5 : v/midpoint*0.5;
}
function depth(v,s) { const c=curve(v,s.curve,s.midpoint); return c*s.outward-(1-c)*s.inward; }
function depth01(v,s) { let c=curve(v,s.curve,s.midpoint); if(s.invert)c=1-c; return c; }

function faceGeometry(base,direction,width,height) {
    const f=base ? base.from : [0,0,0], t=base ? base.to : [width,height,0];
    if(direction==='east'||direction==='west') return {a0:f[2],a1:t[2],b0:f[1],b1:t[1],normalAxis:0,normalSign:direction==='east'?1:-1,planeA:'z',planeB:'y'};
    if(direction==='up'||direction==='down') return {a0:f[0],a1:t[0],b0:f[2],b1:t[2],normalAxis:1,normalSign:direction==='up'?1:-1,planeA:'x',planeB:'z'};
    return {a0:f[0],a1:t[0],b0:f[1],b1:t[1],normalAxis:2,normalSign:direction==='south'?1:-1,planeA:'x',planeB:'y'};
}
function faceDefault(base,found) { return found || (base ? 'north' : 'south'); }

function mapPoint(g,a,b,n0,n1) {
    const p=[0,0,0];
    p[g.planeA==='x'?0:g.planeA==='y'?1:2]=a;
    p[g.planeB==='x'?0:g.planeB==='y'?1:2]=b;
    p[g.normalAxis]=n0;
    return p;
}
function makeWorldCube(g,a0,a1,b0,b1,n0,n1,uv,texture,group,name) {
    const p0=mapPoint(g,a0,b0,n0,n1), p1=mapPoint(g,a1,b1,n0,n1);
    const from=[Math.min(p0[0],p1[0]),Math.min(p0[1],p1[1]),Math.min(p0[2],p1[2])];
    const to=[Math.max(p0[0],p1[0]),Math.max(p0[1],p1[1]),Math.max(p0[2],p1[2])];
    if(to[g.normalAxis]-from[g.normalAxis]<SURFACE_THICKNESS) {
        if(g.normalSign>0) to[g.normalAxis]=from[g.normalAxis]+SURFACE_THICKNESS;
        else from[g.normalAxis]=to[g.normalAxis]-SURFACE_THICKNESS;
    }
    const faces={};
    for(const d of DIRECTIONS) faces[d]={uv:[uv[0],uv[1],uv[2],uv[3]],texture,rotation:0,enabled:true};
    return new Cube({name,from,to,box_uv:false,autouv:0,shade:false,faces,export:true}).init().addTo(group);
}

function hiddenOptimize(items) {
    const maps={east:new Map(),west:new Map(),up:new Map(),down:new Map()};
    const add=(m,k,s,e,item)=>{if(!m.has(k))m.set(k,[]);m.get(k).push([s,e,item]);};
    for(const it of items){const c=it.cube;add(maps.east,`${c.to[0]}|${c.from[2]}|${c.to[2]}`,c.from[1],c.to[1],it);add(maps.west,`${c.from[0]}|${c.from[2]}|${c.to[2]}`,c.from[1],c.to[1],it);add(maps.up,`${c.from[1]}|${c.from[2]}|${c.to[2]}`,c.from[0],c.to[0],it);add(maps.down,`${c.to[1]}|${c.from[2]}|${c.to[2]}`,c.from[0],c.to[0],it);}
    function covered(arr,s,e){arr=arr.slice().sort((a,b)=>a[0]-b[0]);let p=s;for(const q of arr){if(q[1]<=p+EPSILON)continue;if(q[0]>p+EPSILON)return false;p=Math.max(p,q[1]);if(p>=e-EPSILON)return true;}return p>=e-EPSILON;}
    let n=0;
    for(const it of items){const c=it.cube;const checks=[['east',maps.west,c.to[0],c.from[1],c.to[1]],['west',maps.east,c.from[0],c.from[1],c.to[1]],['up',maps.down,c.from[1],c.from[0],c.to[0]],['down',maps.up,c.to[1],c.from[0],c.to[0]]];for(const [d,m,plane,s,e] of checks){const key=`${plane}|${c.from[2]}|${c.to[2]}`;const arr=(m.get(key)||[]).filter(x=>x[2]!==it).map(x=>[x[0],x[1]]);if(covered(arr,s,e)&&c.faces[d].enabled){c.faces[d].enabled=false;n++;}}}
    return n;
}

function mergeCells(cells,width,height,enabled) {
    const grid=Array.from({length:height},()=>Array(width).fill(null));
    for(const c of cells) grid[c.y][c.x]=c;
    const out=[];
    for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
        const c=grid[y][x]; if(!c||c.used)continue;
        let w=1; while(x+w<width){const q=grid[y][x+w];if(!q||q.used||Math.abs(q.depth-c.depth)>1e-4)break;w++;}
        let h=1; while(y+h<height){let ok=true;for(let xx=0;xx<w;xx++){const q=grid[y+h][x+xx];if(!q||q.used||Math.abs(q.depth-c.depth)>1e-4){ok=false;break;}}if(!ok)break;h++;}
        for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++)grid[y+yy][x+xx].used=true;
        out.push({x,y,w,h,depth:c.depth,uvX:x/width,uvY:y/height,uvW:w/width,uvH:h/height});
    }
    return out;
}

function smoothValues(values,width,height,mode) {
    if(mode==='off')return values;
    const radius=mode==='medium'?2:1, out=new Float32Array(values.length);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){let sum=0,n=0;for(let yy=-radius;yy<=radius;yy++)for(let xx=-radius;xx<=radius;xx++){const nx=clamp(x+xx,0,width-1),ny=clamp(y+yy,0,height-1);sum+=values[ny*width+nx];n++;}out[y*width+x]=sum/n;}
    return out;
}

function generate(form) {
    const base=selectedCube(), src=sourceTexture(base); if(!src)return errorBox('Select a textured cube or an original color texture first.');
    const pd=pixels(src.texture); if(!pd)return errorBox('The selected texture could not be read.');
    const {width,height,data}=pd; if(width*height>(mobile()?MOBILE_MAX_MAP_PIXELS:DESKTOP_MAX_MAP_PIXELS))return errorBox('This texture is too large for the mobile-safe generator.');
    let direction=form.direction==='auto'?src.direction:null; direction=faceDefault(base,direction);
    const g=faceGeometry(base,direction,width,height);
    const outward=Math.max(0,Number(form.outward)||0), inward=Math.max(0,Number(form.inward)||0);
    const settings={curve:form.curve||'linear',midpoint:Number(form.midpoint)||0.5,invert:!!form.invert,smooth:form.smooth||'off',alpha:Number(form.alpha)||1,outward,inward};
    const raw=new Float32Array(width*height), valid=[];
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4,a=data[i+3]/255;if(a<settings.alpha)continue;raw[y*width+x]=lum(data[i],data[i+1],data[i+2]);valid.push({x,y});}
    const sm=smoothValues(raw,width,height,settings.smooth);
    for(const c of valid)c.depth=depth(sm[c.y*width+c.x],settings);
    if(cellsTooMany(valid.length))return;
    const merged=form.merge!==false?mergeCells(valid,width,height,true):valid.map(c=>({x:c.x,y:c.y,w:1,h:1,depth:c.depth,uvX:c.x/width,uvY:c.y/height,uvW:1/width,uvH:1/height}));
    if(merged.length>cubeLimit())return errorBox(`3D DP would create ${merged.length} cubes. The safe limit on this device is ${cubeLimit()}. Reduce the texture size or increase smoothing/merging.`);
    const group=new Group({name:'3D DP Parallax',origin:base?base.from.slice():[0,0,0]}).init().addTo(Panels.outliner.root);
    const items=[]; const planeW=g.a1-g.a0, planeH=g.b1-g.b0;
    for(const m of merged){
        const a0=g.a0+planeW*(m.x/width), a1=g.a0+planeW*((m.x+m.w)/width);
        const b0=g.b0+planeH*(m.y/height), b1=g.b0+planeH*((m.y+m.h)/height);
        const surface=base ? (direction==='south'?base.to[2]:direction==='north'?base.from[2]:direction==='east'?base.to[0]:direction==='west'?base.from[0]:direction==='up'?base.to[1]:base.from[1]) : 0;
        const n0=surface, n1=surface+g.normalSign*m.depth;
        const cube=makeWorldCube(g,a0,a1,b0,b1,n0,n1,[m.uvX,m.uvY,m.uvW,m.uvH],src.texture,group,`3D DP ${m.x},${m.y}`);items.push({cube});
    }
    hiddenOptimize(items);
    if(base && base.faces[direction]) base.faces[direction].enabled=false;
    Undo.finishEdit('Generate 3D Depth Parallax');
    Canvas.updateAll();
    Group.selected=group;
    return {count:merged.length,direction};
}
function cellsTooMany(n){if(n>cubeLimit()){errorBox(`The source would use ${n} cells, above the safe limit of ${cubeLimit()}. Use a smaller texture or enable merging.`);return true;}return false;}

function textureFromCanvas(name,canvas,channel){const t=new Texture({name,width:canvas.width,height:canvas.height,uv_width:canvas.width,uv_height:canvas.height});t.fromDataURL(canvas.toDataURL('image/png')).add();if(channel)t.pbr_channel=channel;return t;}
function depthMapCanvas(width,height,data,s){const c=document.createElement('canvas');c.width=width;c.height=height;const x=c.getContext('2d'),o=x.createImageData(width,height);for(let i=0;i<data.length;i+=4){let v=lum(data[i],data[i+1],data[i+2]);v=curve(v,s.curve,s.midpoint);if(s.invert)v=1-v;const q=Math.round(v*255);o.data[i]=o.data[i+1]=o.data[i+2]=q;o.data[i+3]=data[i+3];}x.putImageData(o,0,0);return c;}
function pbrCanvases(width,height,data,s){const nc=document.createElement('canvas'),mc=document.createElement('canvas');nc.width=mc.width=width;nc.height=mc.height=height;const nx=nc.getContext('2d'),mx=mc.getContext('2d'),no=nx.createImageData(width,height),mo=mx.createImageData(width,height);const sample=(px,py)=>{px=clamp(px,0,width-1);py=clamp(py,0,height-1);const i=(py*width+px)*4;let v=curve(lum(data[i],data[i+1],data[i+2]),s.curve,s.midpoint);if(s.invert)v=1-v;return v;};const strength=Math.max(0,Number(s.normal_strength)||1);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4,l=sample(x-1,y),r=sample(x+1,y),u=sample(x,y-1),d=sample(x,y+1),a=-(r-l)*strength,b=-(d-u)*strength,z=1,len=Math.sqrt(a*a+b*b+z*z)||1;no.data[i]=((a/len)*.5+.5)*255;no.data[i+1]=((b/len)*.5+.5)*255;no.data[i+2]=((z/len)*.5+.5)*255;no.data[i+3]=data[i+3];mo.data[i]=clamp(Number(s.metallic)||0,0,1)*255;mo.data[i+1]=clamp(Number(s.emissive)||0,0,1)*255;mo.data[i+2]=clamp(Number(s.roughness)||0.5,0,1)*255;mo.data[i+3]=data[i+3];}nx.putImageData(no,0,0);mx.putImageData(mo,0,0);return [nc,mc];}

function prepareMaps(form){const src=sourceTexture(null);if(!src)return errorBox('Select the original color texture first.');const pd=pixels(src.texture);if(!pd)return errorBox('The selected texture could not be read.');const {width,height,data}=pd;if(width*height>(mobile()?MOBILE_MAX_MAP_PIXELS:DESKTOP_MAX_MAP_PIXELS))return errorBox('This texture is too large for the mobile-safe map generator.');const s={curve:form.curve||'linear',midpoint:Number(form.midpoint)||.5,invert:!!form.invert,normal_strength:Number(form.normal_strength)||1,roughness:Number(form.roughness),metallic:Number(form.metallic),emissive:Number(form.emissive)};const p=plugin(),made=[];if(form.height!==false){const t=textureFromCanvas('3D DP Depth Scale',depthMapCanvas(width,height,data,s),'height');made.push(t);if(p)p.depth_texture=t;}if(form.normal){const cs=pbrCanvases(width,height,data,s),t=textureFromCanvas('3D DP Normal',cs[0],'normal');made.push(t);if(p)p.pbr_textures=[t];}if(form.mer){const cs=pbrCanvases(width,height,data,s),t=textureFromCanvas('3D DP MER (Metallic/Emissive/Roughness)',cs[1],'mer');made.push(t);if(p)p.pbr_textures=(p.pbr_textures||[]).concat(t);}if(p){p.source_texture=src.texture;p.settings=s;}Texture.selected=src.texture;Canvas.updateAll();return made;}

function drawPreview(canvas,texture,form,previewDepth){const pd=pixels(texture);if(!pd)return;const ctx=canvas.getContext('2d'),w=canvas.width=canvas.clientWidth||360,h=canvas.height=canvas.clientHeight||220;ctx.clearRect(0,0,w,h);const scale=Math.min((w-20)/pd.width,(h-20)/pd.height),dw=pd.width*scale,dh=pd.height*scale,x0=(w-dw)/2,y0=(h-dh)/2;const img=document.createElement('canvas');img.width=pd.width;img.height=pd.height;const ix=img.getContext('2d'),im=ix.createImageData(pd.width,pd.height);for(let i=0;i<pd.data.length;i+=4){let v=lum(pd.data[i],pd.data[i+1],pd.data[i+2]);v=curve(v,form.curve||'linear',Number(form.midpoint)||.5);if(form.invert)v=1-v;const q=Math.round(v*255);im.data[i]=im.data[i+1]=im.data[i+2]=q;im.data[i+3]=pd.data[i+3];}ix.putImageData(im,0,0);ctx.imageSmoothingEnabled=false;ctx.drawImage(img,x0,y0,dw,dh);if(previewDepth){ctx.globalAlpha=.28;ctx.save();ctx.translate(previewDepth*2,-previewDepth);ctx.drawImage(img,x0,y0,dw,dh);ctx.restore();ctx.globalAlpha=1;}}

function openDialog(){const p=plugin();if(p&&p.dialog){p.dialog.show();return;}const base=selectedCube(),src=sourceTexture(base);const form={outward:4,inward:4,curve:'linear',midpoint:.5,invert:false,smooth:'low',alpha:1,merge:true,direction:'auto'};const content={
    text:{type:'info',text:'Bright pixels move outward; dark pixels move inward. A selected cube face is used automatically.'},
    outward:{type:'number',label:'Max outward depth',value:4,min:0,max:64,step:.1},
    inward:{type:'number',label:'Max inward depth',value:4,min:0,max:64,step:.1},
    curve:{type:'select',label:'Depth curve',options:{linear:'Linear',soft:'Soft',strong:'Strong',contrast:'Contrast'}},
    midpoint:{type:'number',label:'Midpoint',value:.5,min:.01,max:.99,step:.01},
    invert:{type:'checkbox',label:'Invert depth',value:false},
    smooth:{type:'select',label:'Depth smoothing',options:{off:'Off',low:'Low',medium:'Medium'}},
    alpha:{type:'number',label:'Transparency threshold',value:1,min:0,max:1,step:.01},
    merge:{type:'checkbox',label:'Merge equal-depth regions',value:true},
    direction:{type:'select',label:'Projection face',options:{auto:'Auto / selected face',north:'North',south:'South',east:'East',west:'West',up:'Up',down:'Down'}},
    preview:{type:'html',html:'<canvas id="3d-dp-preview" style="width:100%;height:220px;image-rendering:pixelated;border:1px solid var(--color-border);"></canvas><div style="display:flex;gap:8px;align-items:center"><span>3D preview depth</span><input id="3d-dp-preview-depth" type="range" min="0" max="32" value="8" style="flex:1"></div>'},
    generate:{type:'button',label:'Generate 3D Geometry',click:function(){form.outward=Number(this.outward);form.inward=Number(this.inward);form.curve=this.curve;form.midpoint=Number(this.midpoint);form.invert=!!this.invert;form.smooth=this.smooth;form.alpha=Number(this.alpha);form.merge=!!this.merge;form.direction=this.direction;Undo.initEdit({elements:[],outliner:true,selection:true});try{const r=generate(form);if(r)Blockbench.showQuickMessage(`3D DP generated ${r.count} merged regions on ${r.direction}.`);else Undo.cancelEdit();}catch(e){Undo.cancelEdit();console.error('[3D DP]',e);errorBox('3D DP generation failed. See the console for details.');}}}
};
const d=new Dialog({id:'3d_dp_dialog',title:'3D DP — Depth Parallax',form:content,onConfirm(){this.generate.click.call(this);}});p.dialog=d;d.show();setTimeout(()=>{const c=document.getElementById('3d-dp-preview'),s=document.getElementById('3d-dp-preview-depth');if(c&&src){const redraw=()=>drawPreview(c,src.texture,form,Number(s.value)||0);s&&s.addEventListener('input',redraw);redraw();}},0);}

function openMapDialog(){const p=plugin();if(p&&p.map_dialog){p.map_dialog.show();return;}const form={curve:'linear',midpoint:.5,invert:false,height:true,normal:true,mer:true,normal_strength:1,roughness:.5,metallic:0,emissive:0};const content={
    info:{type:'info',text:'Create standard Blockbench height/normal/MER textures. No custom material system is added.'},
    curve:{type:'select',label:'Depth curve',options:{linear:'Linear',soft:'Soft',strong:'Strong',contrast:'Contrast'}},
    midpoint:{type:'number',label:'Midpoint',value:.5,min:.01,max:.99,step:.01},
    invert:{type:'checkbox',label:'Invert depth',value:false},
    height:{type:'checkbox',label:'Create Height map',value:true},
    normal:{type:'checkbox',label:'Create Normal map',value:true},
    mer:{type:'checkbox',label:'Create MER map',value:true},
    normal_strength:{type:'number',label:'Normal strength',value:1,min:0,max:8,step:.1},
    metallic:{type:'number',label:'Metallic',value:0,min:0,max:1,step:.01},
    roughness:{type:'number',label:'Roughness',value:.5,min:0,max:1,step:.01},
    emissive:{type:'number',label:'Emissive',value:0,min:0,max:1,step:.01},
    preview:{type:'html',html:'<canvas id="3d-dp-map-preview" style="width:100%;height:180px;image-rendering:pixelated;border:1px solid var(--color-border);"></canvas>'},
    create:{type:'button',label:'Create Maps',click:function(){form.curve=this.curve;form.midpoint=Number(this.midpoint);form.invert=!!this.invert;form.height=!!this.height;form.normal=!!this.normal;form.mer=!!this.mer;form.normal_strength=Number(this.normal_strength);form.metallic=Number(this.metallic);form.roughness=Number(this.roughness);form.emissive=Number(this.emissive);try{const made=prepareMaps(form);if(made)Blockbench.showQuickMessage(`Created ${made.length} 3D DP map${made.length===1?'':'s'}.`);}catch(e){console.error('[3D DP]',e);errorBox('3D DP map generation failed.');}}}
};const d=new Dialog({id:'3d_dp_maps_dialog',title:'3D DP — Depth & PBR Maps',form:content});p.map_dialog=d;d.show();setTimeout(()=>{const c=document.getElementById('3d-dp-map-preview'),src=sourceTexture(null);if(c&&src)drawPreview(c,src.texture,form,0);},0);}
