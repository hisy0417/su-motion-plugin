figma.showUI(__html__, {
  width: 320,
  height: 580,
  title: 'ST Motion Tokens'
});

function notifySelection() {
  const nodes = figma.currentPage.selection;
  figma.ui.postMessage({
    type: 'selection-info',
    count: nodes.length,
    names: nodes.slice(0, 3).map(n => n.name)
  });
}

figma.on('selectionchange', notifySelection);

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'get-selection') {
    notifySelection();
    return;
  }

  if (msg.type === 'apply-token') {
    const nodes = figma.currentPage.selection;
    if (nodes.length === 0) {
      figma.ui.postMessage({ type: 'apply-error', message: '레이어를 먼저 선택하세요' });
      return;
    }

    let applied = 0;
    for (const node of nodes) {
      if (!('reactions' in node)) continue;
      const reactions = node.reactions;

      let easing;
      if (msg.isSpring) {
        easing = { type: 'SPRING' };
      } else if (msg.bezier) {
        easing = {
          type: 'CUSTOM_CUBIC_BEZIER',
          easingFunctionCubicBezier: {
            x1: msg.bezier[0], y1: msg.bezier[1],
            x2: msg.bezier[2], y2: msg.bezier[3]
          }
        };
      } else {
        easing = { type: 'EASE_OUT' };
      }

      const durationSec = msg.duration ? msg.duration / 1000 : 0.3;

      try {
        if (reactions.length === 0) {
          node.reactions = [{
            trigger: { type: 'ON_CLICK' },
            action: {
              type: 'NODE', destinationId: null, navigation: 'NAVIGATE',
              transition: { type: 'MOVE_IN', direction: 'LEFT', matchLayers: false, easing, duration: durationSec },
              preserveScrollPosition: false
            }
          }];
        } else {
          node.reactions = reactions.map(r => {
            if (r.action && r.action.transition) {
              return { ...r, action: { ...r.action, transition: { ...r.action.transition, easing, duration: durationSec } } };
            }
            return r;
          });
        }
        applied++;
      } catch(e) {}
    }

    figma.ui.postMessage({ type: 'apply-success', count: applied, tokenName: msg.tokenName });
  }
};
