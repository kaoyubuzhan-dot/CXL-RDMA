/* Read-only projection of the experiment for both hardware views. */
(function () {
  'use strict';

  const S = window.__SIM__;
  const { D, STATE } = S;
  const spines = Object.freeze(['Spine-1', 'Spine-2']);
  let previous;
  let previousKey;

  function snapshot() {
    const racks = D.RACKS.map(def => {
      const deployed = Boolean(STATE.deployment[def.id]);
      const torId = `${def.id}-ToR`;
      const nodes = def.nodes.map(node => ({
        id: node.id, deviceId: `${def.id}-${node.id}`, role: node.role
      }));
      const units = (deployed ? S.mhdUnitsForRack(def.id) : []).map(unit => ({
        id: unit.id, capacityGB: unit.capacityGB, hostInterfaces: unit.hostInterfaces,
        usedGB: S.computeMhdUsed(unit.id)
      }));
      const links = [];
      const portsUsed = new Map();
      if (deployed) {
        for (const { node, mhdId, hostPort } of STATE.cxlLinks[def.id] || []) {
          const unit = units.find(item => item.id === mhdId);
          const portIndex = portsUsed.get(mhdId) || 0;
          if (!unit || portIndex >= unit.hostInterfaces || !nodes.some(item => item.id === node)) continue;
          links.push({ node, mhdId, hostPort, portIndex });
          portsUsed.set(mhdId, portIndex + 1);
        }
      }
      return {
        id: def.id, deployed, torId, nodes, units, links,
        downlinks: nodes.map(node => ({ from: node.deviceId, to: torId })),
        uplinks: spines.map(id => ({ from: torId, to: id }))
      };
    });
    const network = {
      spines,
      pool: {
        id: D.RDMA_POOL.id, capacityGB: D.RDMA_POOL.capacityGB, usedGB: S.rdmaUsed(),
        uplink: spines[1]
      },
      // Pairwise experiment load does not identify which Spine carries a flow.
      logicalLinks: D.LINKS.map(({ id, a, b, load }) => ({
        id, a, b, load: STATE.links[id] ?? load, utilization: STATE.linkFlow[id] ?? null
      }))
    };
    const key = JSON.stringify({ racks, network });
    if (key === previousKey) return previous;
    previousKey = key;
    previous = freeze({ racks, network });
    return previous;
  }

  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }

  window.HARDWARE_MODEL = Object.freeze({ snapshot });
})();
