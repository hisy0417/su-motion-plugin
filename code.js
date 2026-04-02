// ════════════════════════════════════════════════════════════════════════
// ST Motion System v4 — code.js  (Figma plugin main thread)
//
// Responsibilities:
//   1. Auto-scan Prototype connections → FlowGraph
//   2. Selective frame export with base64 image encoding (low-res thumbnail)
//   3. 7-track motion data persistence via clientStorage
//   4. Motion Guide annotation generation on canvas
//   5. Custom token persistence (save/load user-defined tokens)
// ════════════════════════════════════════════════════════════════════════
'use strict';

// ── Constants ─────────────────────────────────────────────────────────
const STORAGE_KEY_FRAME   = 'stms4_frame_';   // prefix for per-frame motion data
const STORAGE_KEY_TOKENS  = 'stms4_tokens';   // custom token library
const STORAGE_KEY_PREFS   = 'stms4_prefs';    // user preferences
const THUMB_MAX_PX        = 120;              // base64 thumbnail max dimension
const THUMB_QUALITY       = 0.55;            // JPEG quality for thumbnails (0-1)
const MAX_LAYERS_DEPTH    = 6;               // max layer tree depth to traverse

// ── Plugin bootstrap ──────────────────────────────────────────────────
figma.showUI(__html__, {
  width:      960,
  height:     600,
  themeColors: true,
});

// ══════════════════════════════════════════════════════════════════════
//  STORAGE HELPERS
// ══════════════════════════════════════════════════════════════════════

async function loadFrameData(frameId) {
  try {
    const raw = await figma.clientStorage.getAsync(STORAGE_KEY_FRAME + frameId);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

async function saveFrameData(frameId, data) {
  await figma.clientStorage.setAsync(STORAGE_KEY_FRAME + frameId, JSON.stringify(data));
}

async function loadCustomTokens() {
  try {
    const raw = await figma.clientStorage.getAsync(STORAGE_KEY_TOKENS);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}

async function saveCustomTokens(tokens) {
  await figma.clientStorage.setAsync(STORAGE_KEY_TOKENS, JSON.stringify(tokens));
}

// ══════════════════════════════════════════════════════════════════════
//  7-TRACK COUNTER  (drives status badges in Flow view)
// ══════════════════════════════════════════════════════════════════════

function count7TrackMotions(motionData) {
  if (!(motionData && motionData.triggers)) return { set: 0, total: 0 };
  let set = 0, total = 0;
  for (const trigger of motionData.triggers) {
    const layerList = (trigger.layers != null ? trigger.layers : []);
    for (const layer of layerList) {
      total++;
      const trackList = (layer.tracks != null ? layer.tracks : []);
      if (trackList.some(function(t) { return t.enabled && t.tokenId; })) set++;
    }
  }
  return { set, total };
}

// ══════════════════════════════════════════════════════════════════════
//  BASE64 THUMBNAIL EXPORTER
//  Exports a Figma node as a low-resolution JPEG base64 string.
//  Steps:
//   1. Export node at 0.5× scale via exportAsync (PNG bytes from Figma)
//   2. Re-encode at THUMB_QUALITY using an OffscreenCanvas (if available)
//      otherwise return the raw PNG base64 (Figma already downscales).
//   Performance: thumbnail is < 8 KB; safe to transmit via postMessage.
// ══════════════════════════════════════════════════════════════════════

async function exportNodeAsBase64Thumb(node) {
  try {
    // Determine scale so longest side ≤ THUMB_MAX_PX
    const longSide = Math.max(node.width, node.height);
    const scale    = longSide > 0 ? Math.min(THUMB_MAX_PX / longSide, 1) : 0.5;

    const bytes = await node.exportAsync({
      format:     'PNG',
      constraint: { type: 'SCALE', value: Math.max(scale, 0.1) },
    });

    // Convert Uint8Array → base64 string
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);
    return 'data:image/png;base64,' + b64;
  } catch (e) {
    // Export failed (e.g. node has no visible content) — return null
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════
//  FILL COLOR EXTRACTOR
// ══════════════════════════════════════════════════════════════════════

function extractFill(node) {
  try {
    const fills = node.fills;
    if (!(fills && fills.length)) return null;
    const f = fills.find(f => f.type === 'SOLID' && f.visible !== false);
    if (!f) return null;
    const { r, g, b } = f.color;
    const a = (f.opacity != null ? f.opacity : 1);
    return 'rgba(' + Math.round(r * 255) + ',' + Math.round(g * 255) + ',' + Math.round(b * 255) + ',' + a.toFixed(3) + ')';
  } catch (e) { return null; }
}

// ══════════════════════════════════════════════════════════════════════
//  LAYER TREE BUILDER
//  Full metadata extraction for the Editor's PreviewRenderer.
//  Each layer object carries:
//    • id, name, type, visible
//    • x, y, width, height (absolute within frame)
//    • frameW, frameH (root frame dimensions for scaling)
//    • opacity, rotation, fillColor, cornerRadius
//    • text, fontSize, fontWeight (TEXT layers)
//    • thumb (base64 PNG thumbnail, only for FRAME/COMPONENT at depth 0-1)
// ══════════════════════════════════════════════════════════════════════

async function buildLayerTree(parentNode, rootNode, depth) {
  if (depth > MAX_LAYERS_DEPTH) return [];
  const children = (parentNode.children != null ? parentNode.children : []);
  const result   = [];
  const FRAME_W  = (rootNode.width != null ? rootNode.width : 390);
  const FRAME_H  = (rootNode.height != null ? rootNode.height : 844);

  for (const child of children) {
    const hasChildren = ((child.children ? child.children.length : 0)) > 0;

    // Absolute position within root frame via absoluteTransform
    let absX = (child.x != null ? child.x : 0), absY = (child.y != null ? child.y : 0);
    try {
      const at = child.absoluteTransform;
      const ft = rootNode.absoluteTransform;
      absX = at[0][2] - ft[0][2];
      absY = at[1][2] - ft[1][2];
    } catch (e) { /* use relative coords */ }

    const layerObj = {
      id:           child.id,
      name:         child.name,
      type:         child.type,
      visible:      child.visible !== false,
      hasChildren,
      x:            absX,
      y:            absY,
      width:        (child.width != null ? child.width : 0),
      height:       (child.height != null ? child.height : 0),
      frameW:       FRAME_W,
      frameH:       FRAME_H,
      opacity:      (child.opacity != null ? child.opacity : 1),
      rotation:     (child.rotation != null ? child.rotation : 0),
      fillColor:    extractFill(child),
      cornerRadius: (child.cornerRadius != null ? child.cornerRadius : 0),
      // TEXT metadata
      text:         child.type === 'TEXT' ? ((child.characters != null ? child.characters : '')) : null,
      fontSize:     child.type === 'TEXT' ? ((child.fontSize != null ? child.fontSize : 14)) : null,
      fontWeight:   child.type === 'TEXT' ? ((child.fontWeight != null ? child.fontWeight : 400)) : null,
    };

    // Base64 thumbnail for direct-render layers at shallow depths
    if (depth <= 1 && (child.type === 'FRAME' || child.type === 'COMPONENT' || child.type === 'INSTANCE')) {
      layerObj.thumb = await exportNodeAsBase64Thumb(child);
    }

    if (hasChildren) {
      layerObj.children = await buildLayerTree(child, rootNode, depth + 1);
    }

    result.push(layerObj);
  }
  return result;
}

// ══════════════════════════════════════════════════════════════════════
//  AUTO-SCAN FLOW GRAPH
//  Traverses all top-level FRAME nodes, reads Prototype reactions,
//  and builds FlowNode + FlowEdge arrays for the Flow View.
// ══════════════════════════════════════════════════════════════════════

async function scanFlowGraph() {
  const page   = figma.currentPage;
  const frames = page.children.filter(n => n.type === 'FRAME' && !n.name.startsWith('_'));

  const nodeMap = {};
  const edgeMap = {};
  let   edgeSeq = 0;

  // Pass 1: build FrameNode entries
  for (const frame of frames) {
    const motionData = await loadFrameData(frame.id);
    const { set, total } = count7TrackMotions(motionData);
    nodeMap[frame.id] = {
      id:         frame.id,
      type:       'frame',
      name:       frame.name,
      width:      frame.width,
      height:     frame.height,
      trackSet:   set,
      trackTotal: total,
      status:     total === 0 ? 'none' : set === total ? 'complete' : 'progress',
      connections: [],
    };
  }

  // Pass 2: walk reactions → build edges, detect conditions
  for (const frame of frames) {
    const motionData = await loadFrameData(frame.id);
    for (const reaction of ((frame.reactions != null ? frame.reactions : []))) {
      if ((reaction.action && reaction.action.type) !== 'NODE') continue;
      const destId = reaction.action.destinationId;
      if (!destId || !nodeMap[destId]) continue;

      const isConditional = !!(reaction.action && reaction.action.transition && reaction.action.transition.conditionExpr);
      const condExpr      = (reaction.action && reaction.action.transition && reaction.action.transition.conditionExpr) ? reaction.action.transition.conditionExpr : null;
      const edgeToken     = (motionData && motionData.edgeTokens) ? (motionData.edgeTokens[destId] != null ? motionData.edgeTokens[destId] : null) : null;
      const edgeId        = 'e' + (++edgeSeq);

      edgeMap[edgeId] = {
        id:          edgeId,
        fromId:      frame.id,
        toId:        destId,
        tokenKey:    edgeToken,
        trigger:     (reaction.trigger ? reaction.trigger.type : 'ON_CLICK'),
        condExpr,
        branchLabel: null,
      };
      nodeMap[frame.id].connections.push(edgeId);

      // Inject ConditionNode between source and destination
      if (isConditional && condExpr) {
        const condId = 'cond_' + edgeId;
        if (!nodeMap[condId]) {
          nodeMap[condId] = {
            id:       condId,
            type:     'condition',
            name:     condExpr,
            condExpr,
            status:   'none',
            trackSet: 0, trackTotal: 0,
            connections: [],
          };
        }
      }
    }
  }

  const nodes     = Object.values(nodeMap);
  const edges     = Object.values(edgeMap);
  const setConns  = edges.filter(e => e.tokenKey).length;

  return {
    nodes,
    edges,
    totalConnections: edges.length,
    motionSet:        setConns,
  };
}

// ══════════════════════════════════════════════════════════════════════
//  SELECTIVE FRAME EXPORT  (for Editor tab preview)
//  Loads one frame's layer tree + optional base64 thumbnails,
//  merges with saved motion data.
// ══════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════
//  SCENE CAPTURE  — full-frame low-res PNG for preview background
//  Resolution: longest side capped at SCENE_BG_MAX_PX (fast transfer)
// ══════════════════════════════════════════════════════════════════════

const SCENE_BG_MAX_PX = 390;  // matches phone-screen width — no upscaling needed

async function captureSceneBg(node) {
  try {
    const longSide = Math.max(node.width, node.height);
    const scale    = longSide > 0 ? Math.min(SCENE_BG_MAX_PX / longSide, 2) : 1;
    const bytes    = await node.exportAsync({
      format:     'PNG',
      constraint: { type: 'SCALE', value: Math.max(scale, 0.25) },
    });
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return 'data:image/png;base64,' + btoa(binary);
  } catch (e) {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════
//  LAYER CAPTURE  — isolated layer PNG with alpha + exact coordinates
//  Resolution: 2× for sharp overlay rendering on retina-like displays
// ══════════════════════════════════════════════════════════════════════

const LAYER_CAPTURE_SCALE = 2;

async function captureLayer(layerId, frameId) {
  // Find the target layer node anywhere on the page
  const layerNode = figma.currentPage.findOne(function(n) { return n.id === layerId; });
  if (!layerNode) {
    figma.ui.postMessage({ type: 'LAYER_CAPTURE_DATA', layerId, error: 'not_found' });
    return;
  }

  // Find the root frame to compute absolute position within it
  const frameNode = figma.currentPage.findOne(function(n) { return n.id === frameId && n.type === 'FRAME'; });

  // Compute absolute position within frame
  let absX = 0, absY = 0;
  try {
    const at = layerNode.absoluteTransform;
    const ft = frameNode ? frameNode.absoluteTransform : [[1,0,0],[0,1,0]];
    absX = at[0][2] - ft[0][2];
    absY = at[1][2] - ft[1][2];
  } catch (e) {
    absX = layerNode.x;
    absY = layerNode.y;
  }

  // Export layer as high-res PNG with alpha channel
  try {
    const bytes = await layerNode.exportAsync({
      format:     'PNG',
      constraint: { type: 'SCALE', value: LAYER_CAPTURE_SCALE },
    });
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = 'data:image/png;base64,' + btoa(binary);

    figma.ui.postMessage({
      type:    'LAYER_CAPTURE_DATA',
      layerId,
      frameId,
      src:     b64,
      x:       absX,
      y:       absY,
      width:   layerNode.width,
      height:  layerNode.height,
      frameW:  frameNode ? frameNode.width  : 390,
      frameH:  frameNode ? frameNode.height : 844,
      opacity: (layerNode.opacity != null ? layerNode.opacity : 1),
    });
  } catch (e) {
    figma.ui.postMessage({ type: 'LAYER_CAPTURE_DATA', layerId, error: 'export_failed' });
  }
}

async function loadFrameForEditor(frameId, exportThumbs) {
  const node = figma.currentPage.findOne(function(n) { return n.id === frameId && n.type === 'FRAME'; });
  if (!node) {
    figma.ui.postMessage({ type: 'FRAME_DATA', frameId, layers: [], motionData: null });
    return;
  }

  const layers     = await buildLayerTree(node, node, 0);
  const motionData = await loadFrameData(frameId);

  // Always capture scene background for preview renderer
  const sceneBg = await captureSceneBg(node);

  figma.ui.postMessage({
    type:       'FRAME_DATA',
    frameId,
    frameName:  node.name,
    frameWidth: node.width,
    frameHeight:node.height,
    framethumb: sceneBg,   // reuse framethumb slot — scene strip + preview bg
    sceneBg:    sceneBg,   // explicit dedicated field for PreviewRenderer
    layers,
    motionData: (motionData != null ? motionData : null),
  });
}

// ══════════════════════════════════════════════════════════════════════
//  MOTION GUIDE GENERATOR  (annotates Figma canvas)
// ══════════════════════════════════════════════════════════════════════

async function generateMotionGuide(frameId) {
  const frame = figma.currentPage.findOne(n => n.id === frameId && n.type === 'FRAME');
  if (!frame) { figma.notify('Frame not found.'); return; }

  const motionData = await loadFrameData(frameId);
  if (!motionData) { figma.notify('No motion data saved for this frame.'); return; }

  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });

  const lines = ['⬛ Motion Guide — ' + frame.name, ''];
  for (const trigger of ((motionData.triggers != null ? motionData.triggers : []))) {
    lines.push('► Trigger: ' + trigger.type.toUpperCase());
    for (const layer of ((trigger.layers != null ? trigger.layers : []))) {
      const active = ((layer.tracks != null ? layer.tracks : [])).filter(t => t.enabled && t.tokenId);
      if (active.length) {
        lines.push('  Layer: ' + layer.name);
        active.forEach(t => lines.push('    [' + t.trackType.padEnd(8) + '] ' + t.tokenId));
      }
    }
    lines.push('');
  }

  const text = figma.createText();
  text.fontName   = { family: 'Inter', style: 'Regular' };
  text.characters = lines.join('\n');
  text.fontSize   = 11;
  text.fills      = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 1 } }];
  text.x = frame.x + frame.width + 32;
  text.y = frame.y;
  figma.currentPage.appendChild(text);
  figma.viewport.scrollAndZoomIntoView([text]);
  figma.notify('Motion Guide generated on canvas ✓');
}

// ══════════════════════════════════════════════════════════════════════
//  SAVE / LOAD HELPERS
// ══════════════════════════════════════════════════════════════════════

async function handleSaveFrameData(payload) {
  await saveFrameData(payload.frameId, payload.data);
  const { set, total } = count7TrackMotions(payload.data);
  const status = total === 0 ? 'none' : set === total ? 'complete' : 'progress';
  figma.ui.postMessage({
    type: 'FRAME_STATUS_UPDATED',
    frameId: payload.frameId, trackSet: set, trackTotal: total, status,
  });
}

async function saveEdgeToken(fromId, toId, tokenKey) {
  const data = (await loadFrameData(fromId)) || {};
  if (!data.edgeTokens) data.edgeTokens = {};
  data.edgeTokens[toId] = tokenKey;
  await saveFrameData(fromId, data);
  figma.ui.postMessage({ type: 'EDGE_TOKEN_SAVED', fromId, toId, tokenKey });
}

async function addSelectionToFlow() {
  const frames = figma.currentPage.selection.filter(n => n.type === 'FRAME');
  if (!frames.length) { figma.notify('Select at least one Frame.'); return; }
  const added = [];
  for (const f of frames) {
    const md = await loadFrameData(f.id);
    const { set, total } = count7TrackMotions(md);
    added.push({
      id: f.id, type: 'frame', name: f.name,
      trackSet: set, trackTotal: total,
      status: total === 0 ? 'none' : set === total ? 'complete' : 'progress',
      connections: [],
    });
  }
  figma.ui.postMessage({ type: 'FRAMES_ADDED', frames: added });
  figma.notify(frames.length + ' frame(s) added to flow.');
}

// ══════════════════════════════════════════════════════════════════════
//  EVENT LISTENERS  (Figma → UI push messages)
// ══════════════════════════════════════════════════════════════════════

figma.on('selectionchange', () => {
  const sel = figma.currentPage.selection;
  if (!sel.length) return;
  const n = sel[0];
  if (n.type !== 'FRAME') return;
  figma.ui.postMessage({ type: 'SELECTION_CHANGED', frameId: n.id, frameName: n.name });
});

figma.on('documentchange', e => {
  const relevant = e.documentChanges.some(c =>
    c.type === 'PROPERTY_CHANGE' &&
    (c.properties.includes('reactions') || c.properties.includes('children'))
  );
  if (relevant) figma.ui.postMessage({ type: 'DESIGN_CHANGED' });
});

// ══════════════════════════════════════════════════════════════════════
//  MESSAGE ROUTER  (UI → Figma main thread)
// ══════════════════════════════════════════════════════════════════════

figma.ui.onmessage = async msg => {
  switch (msg.type) {

    // ── Boot: scan flow + load custom tokens ──────────────────────────
    case 'INIT': {
      const [flowData, customTokens] = await Promise.all([
        scanFlowGraph(),
        loadCustomTokens(),
      ]);
      figma.ui.postMessage({
        type:             'INIT_DATA',
        nodes:            flowData.nodes,
        edges:            flowData.edges,
        totalConnections: flowData.totalConnections,
        motionSet:        flowData.motionSet,
        customTokens,
        selectedFrameId:   figma.currentPage.selection[0] ? figma.currentPage.selection[0].id : null,
        selectedFrameName: figma.currentPage.selection[0] ? figma.currentPage.selection[0].name : null,
      });
      break;
    }

    // ── Flow scan ─────────────────────────────────────────────────────
    case 'SCAN_FLOW': {
      const fd = await scanFlowGraph();
      figma.ui.postMessage({
        type:             'FLOW_DATA',
        nodes:            fd.nodes,
        edges:            fd.edges,
        totalConnections: fd.totalConnections,
        motionSet:        fd.motionSet,
      });
      break;
    }

    // ── Load frame for Editor (with optional base64 thumbnails) ───────
    case 'LOAD_FRAME': {
      await loadFrameForEditor(msg.frameId, (msg.exportThumbs != null ? msg.exportThumbs : false));
      break;
    }

    // ── Capture individual layer PNG with alpha + coordinates ─────────
    case 'CAPTURE_LAYER': {
      await captureLayer(msg.layerId, msg.frameId);
      break;
    }

    // ── Save motion data (7-track) ────────────────────────────────────
    case 'SAVE_FRAME_DATA': {
      await handleSaveFrameData(msg);
      break;
    }

    // ── Edge token assignment ─────────────────────────────────────────
    case 'SAVE_EDGE_TOKEN': {
      await saveEdgeToken(msg.fromId, msg.toId, msg.tokenKey);
      break;
    }

    // ── Add Figma selection to flow manually ──────────────────────────
    case 'ADD_SELECTION_TO_FLOW': {
      await addSelectionToFlow();
      break;
    }

    // ── Motion guide on canvas ────────────────────────────────────────
    case 'GENERATE_GUIDE': {
      await generateMotionGuide(msg.frameId);
      break;
    }

    // ── Custom token CRUD ─────────────────────────────────────────────
    case 'SAVE_CUSTOM_TOKEN': {
      // msg.token: { key, type, bezier?, stiffness?, damping?, duration?, desc }
      const tokens = await loadCustomTokens();
      tokens[msg.token.key] = msg.token;
      await saveCustomTokens(tokens);
      figma.ui.postMessage({ type: 'CUSTOM_TOKEN_SAVED', token: msg.token });
      break;
    }

    case 'DELETE_CUSTOM_TOKEN': {
      const tokens = await loadCustomTokens();
      delete tokens[msg.key];
      await saveCustomTokens(tokens);
      figma.ui.postMessage({ type: 'CUSTOM_TOKEN_DELETED', key: msg.key });
      break;
    }

    case 'LOAD_CUSTOM_TOKENS': {
      const tokens = await loadCustomTokens();
      figma.ui.postMessage({ type: 'CUSTOM_TOKENS_LOADED', tokens });
      break;
    }

    // ── Export token library as JSON ──────────────────────────────────
    case 'EXPORT_TOKENS': {
      const custom = await loadCustomTokens();
      figma.ui.postMessage({
        type: 'TOKENS_EXPORT',
        json: JSON.stringify({ builtin: (msg.builtin != null ? msg.builtin : {}), custom }, null, 2),
      });
      break;
    }

    // ── Resize plugin window ──────────────────────────────────────────
    case 'RESIZE': {
      figma.ui.resize(msg.width, msg.height);
      break;
    }

    // ── Select + focus a layer in Figma canvas ────────────────────────
    case 'SELECT_LAYER': {
      const n = figma.currentPage.findOne(n => n.id === msg.layerId);
      if (n) { figma.currentPage.selection = [n]; figma.viewport.scrollAndZoomIntoView([n]); }
      break;
    }
  }
};
