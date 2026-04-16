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
  width:      1200,
  height:     700,
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
      const tl = (layer.tracks != null ? layer.tracks : []);
      if (tl.some(function(t) { return t.enabled && t.tokenId; })) set++;
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
    const longSide = Math.max(node.width, node.height);
    const scale    = longSide > 0 ? Math.min(THUMB_MAX_PX / longSide, 1) : 0.5;

    const bytes = await node.exportAsync({
      format:     'PNG',
      constraint: { type: 'SCALE', value: Math.max(scale, 0.1) },
    });

    // Chunk-based base64 to avoid call stack overflow
    const CHUNK = 8192;
    let b64 = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const slice = bytes.subarray(i, i + CHUNK);
      b64 += btoa(String.fromCharCode.apply(null, slice));
    }
    return 'data:image/png;base64,' + b64;
  } catch (e) {
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
//  AUTO-SCAN FLOW GRAPH (LEGACY — reaction-based fallback)
//  Preserved as scanFlowGraphLegacy(); called via SCAN_FLOW_LEGACY.
//  Original reaction-based implementation — DO NOT modify.
// ══════════════════════════════════════════════════════════════════════

async function scanFlowGraphLegacy() {
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
      status:     (set > 0 && set === total) ? 'complete' : 'none',
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
//  SCAN FLOW GRAPH V2
//  Phase 2 canvas-based scan:
//    • Touch gesture INSTANCE nodes (inside Frames, FAST component)
//    • FigJam CONNECTOR nodes (page top-level, connects gesture→frame)
//    • Depth detection via Depth1/Depth2/Depth3 named nodes
//    • 9-rule interaction type inference with confidence scoring
//    • ST token auto-mapping per interaction type
// ══════════════════════════════════════════════════════════════════════

async function scanFlowGraphV2() {
  var page = figma.currentPage;

  // ── ST Token mapping ────────────────────────────────────────────────
  var TOKEN_MAP = {
    depthIn:     'st.standard.transition.forward',
    depthOut:    'st.standard.transition.backward',
    bottomsheet: 'st.expressive.transition.contextual',
    popup:       'st.standard.transition.overlay',
    dismiss:     'st.standard.transition.backward',
    tabSwitch:   'st.standard.interactive.smooth',
  };

  // ── Pass 0: collect Depth marker nodes, sort by X ───────────────────
  var depthMarkers = [];
  for (var di = 0; di < page.children.length; di++) {
    var dn = page.children[di];
    if (/^Depth\d+$/.test(dn.name)) {
      var dx = 0;
      try { dx = dn.absoluteTransform[0][2]; } catch (e) { dx = (dn.x != null ? dn.x : 0); }
      depthMarkers.push({ name: dn.name, x: dx });
    }
  }
  depthMarkers.sort(function(a, b) { return a.x - b.x; });

  // ── Pass 1: compute depth X-ranges ──────────────────────────────────
  // depthRanges[i] = { minX, maxX, depth: i+1 }
  var depthRanges = [];
  for (var ri = 0; ri < depthMarkers.length; ri++) {
    var rangeMin = depthMarkers[ri].x;
    var rangeMax = ri + 1 < depthMarkers.length ? depthMarkers[ri + 1].x : Infinity;
    depthRanges.push({ minX: rangeMin, maxX: rangeMax, depth: ri + 1 });
  }

  function getFrameDepth(frameNode) {
    var fx = 0;
    try { fx = frameNode.absoluteTransform[0][2]; } catch (e) { fx = (frameNode.x != null ? frameNode.x : 0); }
    if (depthRanges.length > 0) {
      for (var k = 0; k < depthRanges.length; k++) {
        if (fx >= depthRanges[k].minX && fx < depthRanges[k].maxX) {
          return depthRanges[k].depth;
        }
      }
      return depthRanges.length; // fallback: last depth
    }
    // Fallback: rank frames by X order (computed later)
    return null; // resolved in post-pass
  }

  // ── Pass 2: collect all top-level FRAMEs (excluding _-prefixed) ──────
  var frames = [];
  for (var fi = 0; fi < page.children.length; fi++) {
    var fc = page.children[fi];
    if (fc.type === 'FRAME' && !fc.name.startsWith('_')) {
      frames.push(fc);
    }
  }

  // Fallback depth by X rank when no Depth markers exist
  if (depthRanges.length === 0) {
    var sortedByX = frames.slice().sort(function(a, b) {
      var ax = 0, bx = 0;
      try { ax = a.absoluteTransform[0][2]; } catch (e) { ax = (a.x != null ? a.x : 0); }
      try { bx = b.absoluteTransform[0][2]; } catch (e) { bx = (b.x != null ? b.x : 0); }
      return ax - bx;
    });
    for (var sr = 0; sr < sortedByX.length; sr++) {
      sortedByX[sr].__v2depth__ = sr + 1;
    }
  }

  // Build frameId → frameNode map
  var frameNodeMap = {};
  for (var fni = 0; fni < frames.length; fni++) {
    frameNodeMap[frames[fni].id] = frames[fni];
  }

  // Build frameRegistry with bounds for findNearestFrame()
  // bounds: x/y (top-left), x2/y2 (bottom-right), cx/cy (center)
  var frameRegistry = [];
  for (var fri = 0; fri < frames.length; fri++) {
    var frn = frames[fri];
    var frAbsX = 0, frAbsY = 0;
    try { frAbsX = frn.absoluteTransform[0][2]; } catch (e) { frAbsX = (frn.x != null ? frn.x : 0); }
    try { frAbsY = frn.absoluteTransform[1][2]; } catch (e) { frAbsY = (frn.y != null ? frn.y : 0); }
    frameRegistry.push({
      id:     frn.id,
      name:   frn.name,
      bounds: {
        x:  frAbsX,
        y:  frAbsY,
        x2: frAbsX + frn.width,
        y2: frAbsY + frn.height,
        cx: frAbsX + frn.width  / 2,
        cy: frAbsY + frn.height / 2,
      },
    });
  }

  // Normalise raw gesture string to lowercase canonical form
  function normaliseGestureType(raw) {
    if (!raw) return 'tap';
    var s = String(raw).toLowerCase().trim();
    return s;
  }

  // ── Pass 3: collect Touch gesture INSTANCEs from page top-level ──────
  // CONFIRMED via MCP analysis: Touch gesture is at page root, NOT inside Frames
  var gestureNodes = [];
  var pageChildren = page.children;
  for (var tgi = 0; tgi < pageChildren.length; tgi++) {
    var tgn = pageChildren[tgi];
    if (tgn.type === 'INSTANCE' && tgn.name === 'Touch gesture') {
      var tgRaw = 'tap';
      try {
        var cp = tgn.componentProperties;
        if (cp && cp['Type'] != null && cp['Type'].value != null) {
          tgRaw = cp['Type'].value;
        }
      } catch (e) { tgRaw = 'tap'; }
      var tgAbsX = 0, tgAbsY = 0;
      try { tgAbsX = tgn.absoluteTransform[0][2]; } catch (e) { tgAbsX = (tgn.x != null ? tgn.x : 0); }
      try { tgAbsY = tgn.absoluteTransform[1][2]; } catch (e) { tgAbsY = (tgn.y != null ? tgn.y : 0); }
      gestureNodes.push({
        id:          tgn.id,
        gestureType: normaliseGestureType(tgRaw),
        gestureRaw:  tgRaw,
        absX:        tgAbsX,
        absY:        tgAbsY,
      });
    }
  }

  // gestureId → gestureInfo fast lookup map
  var gestureMap = {};
  for (var gmi = 0; gmi < gestureNodes.length; gmi++) {
    gestureMap[gestureNodes[gmi].id] = gestureNodes[gmi];
  }

  // ── Pass 4: collect CONNECTOR nodes from page top-level ──────────────
  // CRITICAL: DO NOT early-return on non-FRAME type — scan everything
  var connectors = [];
  for (var pci = 0; pci < pageChildren.length; pci++) {
    if (pageChildren[pci].type === 'CONNECTOR') {
      connectors.push(pageChildren[pci]);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  // Find nearest top-level Frame for a page-top-level Touch gesture.
  // 1st pass: return Frame whose bounding box contains absX/absY exactly.
  // 2nd pass (fallback): return Frame with smallest Euclidean distance to center.
  function findNearestFrame(absX, absY) {
    // 1차: 좌표가 Frame 경계 안에 있는지 확인
    for (var i = 0; i < frameRegistry.length; i++) {
      var fr = frameRegistry[i];
      var b = fr.bounds;
      if (absX >= b.x && absX <= b.x2 && absY >= b.y && absY <= b.y2) {
        return fr;
      }
    }
    // 2차 fallback: 유클리드 거리로 가장 가까운 Frame
    var nearest = null;
    var minDist = Infinity;
    for (var j = 0; j < frameRegistry.length; j++) {
      var fr2 = frameRegistry[j];
      var dx = absX - fr2.bounds.cx;
      var dy = absY - fr2.bounds.cy;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < minDist) {
        minDist = dist;
        nearest = fr2;
      }
    }
    return nearest;
  }

  // Find owner Frame for a given nodeId:
  //   - direct match in frameRegistry
  //   - or walk parent chain to reach a top-level Frame
  function findOwnerFrame(nodeId) {
    for (var i = 0; i < frameRegistry.length; i++) {
      if (frameRegistry[i].id === nodeId) return frameRegistry[i];
    }
    var target = null;
    try {
      target = figma.currentPage.findOne(function(n) { return n.id === nodeId; });
    } catch (e) { return null; }
    if (!target) return null;
    var current = target.parent;
    while (current != null) {
      for (var j = 0; j < frameRegistry.length; j++) {
        if (frameRegistry[j].id === current.id) return frameRegistry[j];
      }
      current = (current.parent != null ? current.parent : null);
    }
    return null;
  }

  // Debug: report counts to UI before processing
  figma.ui.postMessage({
    type:           'DEBUG_SCAN',
    connectorCount: connectors.length,
    frameCount:     frameRegistry.length,
    gestureCount:   gestureNodes.length,
  });

  // ── Pass 6: interaction type inference ───────────────────────────────
  function inferInteractionType(fromFrame, toFrame, gestureType) {
    var matchCount = 0;
    var interactionType = 'depthIn'; // default

    var toName  = toFrame.name.toLowerCase();
    var gesture = (gestureType != null ? gestureType : '').toLowerCase();

    var toFx = 0, fromFx = 0;
    try { toFx   = toFrame.absoluteTransform[0][2];   } catch (e) { toFx   = (toFrame.x   != null ? toFrame.x   : 0); }
    try { fromFx = fromFrame.absoluteTransform[0][2]; } catch (e) { fromFx = (fromFrame.x  != null ? fromFrame.x : 0); }

    var toFy = 0, fromFy = 0;
    try { toFy   = toFrame.absoluteTransform[1][2];   } catch (e) { toFy   = (toFrame.y   != null ? toFrame.y   : 0); }
    try { fromFy = fromFrame.absoluteTransform[1][2]; } catch (e) { fromFy = (fromFrame.y  != null ? fromFrame.y : 0); }

    var sameSize   = Math.abs(toFrame.width  - fromFrame.width)  < 20 && Math.abs(toFrame.height - fromFrame.height) < 20;
    var smallXDiff = Math.abs(toFx - fromFx) < 60;

    // Rule 1: name contains sheet/bottom/drawer → bottomsheet
    if (/_sheet|bottom|drawer/.test(toName)) { interactionType = 'bottomsheet'; matchCount++; }
    // Rule 2: name contains popup/modal/dialog/toast/alert → popup
    if (/_popup|_modal|_dialog|_toast|alert/.test(toName)) { interactionType = 'popup'; matchCount++; }
    // Rule 3: name contains back/close/dismiss/cancel → dismiss
    if (/back|close|dismiss|cancel/.test(toName)) { interactionType = 'dismiss'; matchCount++; }
    // Rule 4: toFrame.x > fromFrame.x → depthIn
    if (matchCount === 0 && toFx > fromFx) { interactionType = 'depthIn'; matchCount++; }
    // Rule 5: toFrame.x < fromFrame.x → depthOut
    if (matchCount === 0 && toFx < fromFx) { interactionType = 'depthOut'; matchCount++; }
    // Rule 6: toFrame.width < fromFrame.width * 0.85 → popup
    if (toFrame.width < fromFrame.width * 0.85) { interactionType = 'popup'; matchCount++; }
    // Rule 7: toFrame.y > fromFrame.y + fromFrame.height * 0.3 → bottomsheet
    if (toFy > fromFy + fromFrame.height * 0.3) { interactionType = 'bottomsheet'; matchCount++; }
    // Rule 8: same size + small x diff → tabSwitch
    if (sameSize && smallXDiff) { interactionType = 'tabSwitch'; matchCount++; }
    // Rule 9: swipe or flick gesture → dismiss
    if (gesture === 'swipe' || gesture === 'flick') { interactionType = 'dismiss'; matchCount++; }

    var confidence = matchCount >= 3 ? 'HIGH' : matchCount === 2 ? 'MED' : 'LOW';
    return { interactionType: interactionType, confidence: confidence };
  }

  // ── Pass 7: build FlowNode + FlowEdge arrays ─────────────────────────
  var nodeMap = {};
  var edgeList = [];
  var edgeSeq  = 0;

  // Pre-build nodeMap from all frames (with absoluteX/Y for layout)
  for (var ni = 0; ni < frames.length; ni++) {
    var nf = frames[ni];
    var motionData = await loadFrameData(nf.id);
    var counts = count7TrackMotions(motionData);
    var depth = null;
    if (depthRanges.length > 0) {
      depth = getFrameDepth(nf);
    } else {
      depth = (nf.__v2depth__ != null ? nf.__v2depth__ : 1);
    }
    var absX = 0, absY = 0;
    try { absX = nf.absoluteTransform[0][2]; } catch (e) { absX = (nf.x != null ? nf.x : 0); }
    try { absY = nf.absoluteTransform[1][2]; } catch (e) { absY = (nf.y != null ? nf.y : 0); }

    // Collect first INSTANCE child as representative component
    var compName = null;
    var compType = null;
    try {
      var frameChildren = (nf.children != null ? nf.children : []);
      for (var fci = 0; fci < frameChildren.length; fci++) {
        var fch = frameChildren[fci];
        if (fch.type === 'INSTANCE') {
          compName = fch.name;
          var fcp = fch.componentProperties;
          if (fcp && fcp['Type'] != null && fcp['Type'].value != null) {
            compType = String(fcp['Type'].value);
          }
          break;
        }
      }
    } catch (e) {}

    nodeMap[nf.id] = {
      id:          nf.id,
      type:        'frame',
      name:        nf.name,
      depth:       depth,
      absoluteX:   absX,
      absoluteY:   absY,
      width:       nf.width,
      height:      nf.height,
      trackSet:    counts.set,
      trackTotal:  counts.total,
      status:      (counts.set > 0 && counts.set === counts.total) ? 'complete' : 'none',
      connections: [],
      componentName: compName,
      componentType: compType,
    };
  }

  // Process each connector
  for (var ci2 = 0; ci2 < connectors.length; ci2++) {
    var conn = connectors[ci2];

    var startId = null, endId = null;
    try { startId = conn.connectorStart.endpointNodeId; } catch (e) { startId = null; }
    try { endId   = conn.connectorEnd.endpointNodeId;   } catch (e) { endId   = null; }
    if (!startId || !endId) continue;

    // startId → Touch gesture (page top-level) → nearest Frame
    var gesture = (gestureMap[startId] != null ? gestureMap[startId] : null);
    var sourceFrame = null;
    if (gesture) {
      sourceFrame = findNearestFrame(gesture.absX, gesture.absY);
    } else {
      // Fallback: startId may directly be a Frame or child of one
      sourceFrame = findOwnerFrame(startId);
    }
    if (!sourceFrame) continue;

    // endId → destFrame: 3단계 fallback
    // 방법 1: endId가 frameRegistry의 Frame 자신인 경우 직접 매칭
    var destFrame = null;
    for (var dfi = 0; dfi < frameRegistry.length; dfi++) {
      if (frameRegistry[dfi].id === endId) {
        destFrame = frameRegistry[dfi];
        break;
      }
    }

    // 방법 2: CONNECTOR absoluteBoundingBox 끝점 좌표로 Frame 찾기
    // (endId가 컴포넌트 내부 레이어라 findOne()으로 탐색 불가한 경우 대비)
    if (!destFrame) {
      try {
        var cb = conn.absoluteBoundingBox;
        if (cb != null) {
          var endX = cb.x + cb.width;
          var endY = cb.y + cb.height / 2;
          for (var dfi2 = 0; dfi2 < frameRegistry.length; dfi2++) {
            var fb = frameRegistry[dfi2].bounds;
            if (endX >= fb.x && endX <= fb.x2 &&
                endY >= fb.y && endY <= fb.y2) {
              destFrame = frameRegistry[dfi2];
              break;
            }
          }
        }
      } catch (e) {}
    }

    // 방법 3: findOwnerFrame() parent chain fallback
    if (!destFrame) {
      destFrame = findOwnerFrame(endId);
    }

    if (!destFrame) continue;

    // Skip self-loops
    if (sourceFrame.id === destFrame.id) continue;

    // Ensure both frames are registered in nodeMap
    if (!nodeMap[sourceFrame.id] || !nodeMap[destFrame.id]) continue;

    // gestureType from Touch gesture INSTANCE, fallback to connector name
    var gestureType = gesture
      ? gesture.gestureType
      : normaliseGestureType((conn.name != null ? conn.name : 'tap'));
    var gestureRaw = gesture
      ? gesture.gestureRaw
      : (conn.name != null ? conn.name : 'tap');

    // Load saved edge token + status
    var srcMotionData = await loadFrameData(sourceFrame.id);
    var savedToken = null;
    var savedStatus = null;
    if (srcMotionData && srcMotionData.edgeTokens) {
      savedToken = (srcMotionData.edgeTokens[destFrame.id] != null ? srcMotionData.edgeTokens[destFrame.id] : null);
    }
    if (srcMotionData && srcMotionData.edgeStatus) {
      savedStatus = (srcMotionData.edgeStatus[destFrame.id] != null ? srcMotionData.edgeStatus[destFrame.id] : null);
    }
    var resolvedStatus = (savedStatus != null ? savedStatus : (savedToken ? 'confirmed' : 'suggested'));

    // Infer interaction type
    var inference      = inferInteractionType(sourceFrame, destFrame, gestureType);
    var iType          = inference.interactionType;
    var conf           = inference.confidence;
    var suggestedToken = (TOKEN_MAP[iType] != null ? TOKEN_MAP[iType] : TOKEN_MAP['depthIn']);

    var edgeId = 'e' + (++edgeSeq);
    edgeList.push({
      id:              edgeId,
      fromFrameId:     sourceFrame.id,
      toFrameId:       destFrame.id,
      gestureType:     gestureType,
      gestureRaw:      gestureRaw,
      interactionType: iType,
      confidence:      conf,
      suggestedToken:  suggestedToken,
      confirmedToken:  savedToken,
      status:          resolvedStatus,
      tokenKey:        (savedToken != null ? savedToken : suggestedToken),
      label:           gestureType + ' \u00b7 ' + iType + ' \u00b7 ' + suggestedToken.split('.').slice(-2).join('.'),
      trigger:         'ON_CLICK',
      condExpr:        null,
      branchLabel:     null,
    });

    nodeMap[sourceFrame.id].connections.push(edgeId);
  }

  // ── Build final output ───────────────────────────────────────────────
  var finalNodes = Object.values(nodeMap);
  var finalEdges = edgeList;
  var setConns   = finalEdges.filter(function(e) { return e.tokenKey; }).length;

  // ── Detect Flows: BFS from in-degree-0 nodes ─────────────────────────
  function detectFlows(nodes, edges) {
    var inDegree = {};
    for (var di = 0; di < nodes.length; di++) {
      inDegree[nodes[di].id] = 0;
    }
    for (var ei = 0; ei < edges.length; ei++) {
      var tid = edges[ei].toFrameId;
      if (inDegree[tid] != null) {
        inDegree[tid] = inDegree[tid] + 1;
      }
    }
    var startNodes = nodes.filter(function(n) {
      return inDegree[n.id] === 0 && n.connections.length > 0;
    });
    var flows = [];
    for (var si = 0; si < startNodes.length; si++) {
      var start = startNodes[si];
      var visited = {};
      var queue = [start.id];
      var flowNodeIds = [];
      while (queue.length > 0) {
        var cur = queue.shift();
        if (visited[cur]) continue;
        visited[cur] = true;
        flowNodeIds.push(cur);
        var curNode = null;
        for (var ni2 = 0; ni2 < nodes.length; ni2++) {
          if (nodes[ni2].id === cur) { curNode = nodes[ni2]; break; }
        }
        if (curNode) {
          for (var ci3 = 0; ci3 < curNode.connections.length; ci3++) {
            var edgeId2 = curNode.connections[ci3];
            var edgeObj = null;
            for (var ei2 = 0; ei2 < edges.length; ei2++) {
              if (edges[ei2].id === edgeId2) { edgeObj = edges[ei2]; break; }
            }
            if (edgeObj && !visited[edgeObj.toFrameId]) {
              queue.push(edgeObj.toFrameId);
            }
          }
        }
      }
      flows.push({
        id:          'flow_' + si,
        name:        start.name + ' Flow',
        startNodeId: start.id,
        nodeIds:     flowNodeIds,
      });
    }
    return flows;
  }

  return {
    nodes:            finalNodes,
    edges:            finalEdges,
    flows:            detectFlows(finalNodes, finalEdges),
    totalConnections: finalEdges.length,
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

const SCENE_BG_MAX_PX = 800;

async function captureSceneBg(node) {
  try {
    // Export at 1x — we just need a visible preview, not retina
    const bytes = await node.exportAsync({
      format:     'PNG',
      constraint: { type: 'WIDTH', value: Math.min(node.width, SCENE_BG_MAX_PX) },
    });

    // Chunk-based base64 encoding to avoid call stack overflow on large frames
    const CHUNK = 8192;
    let b64 = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const slice = bytes.subarray(i, i + CHUNK);
      b64 += btoa(String.fromCharCode.apply(null, slice));
    }
    return 'data:image/png;base64,' + b64;
  } catch (e) {
    figma.ui.postMessage({ type: 'SCENE_CAPTURE_ERROR', error: String(e) });
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
  const status = (set > 0 && set === total) ? 'complete' : 'none';
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
      status: (set > 0 && set === total) ? 'complete' : 'none',
      connections: [],
    });
  }
  figma.ui.postMessage({ type: 'FRAMES_ADDED', frames: added });
  figma.notify(frames.length + ' frame(s) added to flow.');
}

// ══════════════════════════════════════════════════════════════════════
//  EVENT LISTENERS  (Figma → UI push messages)
// ══════════════════════════════════════════════════════════════════════

figma.on('selectionchange', function() {
  var sel = figma.currentPage.selection;
  if (!sel.length) return;
  var n = sel[0];
  // FRAME 선택 시 → Editor 연동
  if (n.type === 'FRAME') {
    figma.ui.postMessage({
      type:      'SELECTION_CHANGED',
      frameId:   n.id,
      frameName: n.name,
    });
    return;
  }
  // CONNECTOR 선택 시 → Flow Edge 하이라이트 연동
  if (n.type === 'CONNECTOR') {
    figma.ui.postMessage({
      type:        'CONNECTOR_SELECTED',
      connectorId: n.id,
    });
  }
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
        scanFlowGraphV2(),
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

    // ── Flow scan (V2 — canvas-based CONNECTOR + gesture) ────────────
    case 'SCAN_FLOW': {
      const fd = await scanFlowGraphV2();
      figma.ui.postMessage({
        type:             'FLOW_DATA',
        nodes:            fd.nodes,
        edges:            fd.edges,
        totalConnections: fd.totalConnections,
        motionSet:        fd.motionSet,
      });
      break;
    }

    // ── Flow scan legacy (reaction-based fallback) ────────────────────
    case 'SCAN_FLOW_LEGACY': {
      const fdl = await scanFlowGraphLegacy();
      figma.ui.postMessage({
        type:             'FLOW_DATA',
        nodes:            fdl.nodes,
        edges:            fdl.edges,
        totalConnections: fdl.totalConnections,
        motionSet:        fdl.motionSet,
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
