/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Extracts the extension from a path.
 *
 * The given path can be either a local path or a URL.
 *
 * @param {string} filenameOrUrl The path to extract the extension for.
 *
 * @return {string} The extracted extension. If there is no extension, an empty
 *     string is returned.
 */
function getFileExtension(filenameOrUrl) {
  // Uses an anchor element's properties to reliably parse URLs/paths
  const a = document.createElement('a');
  a.href = filenameOrUrl;
  const pathname = a.pathname;
  const filename = pathname.substring(pathname.lastIndexOf('/') + 1);
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1 || lastDot === 0 || lastDot === filename.length - 1) {
    // No extension or hidden file like .bashrc
    return '';
  }
  return filename.substring(lastDot + 1).toLowerCase();
}

function getNodeStatus(nodeId) {
  const nodeExecData = executionData[nodeId];

  // 1. Idle: No execution data or no input groups processed yet
  if (
    !nodeExecData ||
    !nodeExecData.inputGroups ||
    Object.keys(nodeExecData.inputGroups).length === 0
  ) {
    return 'idle'; // Grey
  }

  const inputGroupCount = Object.keys(nodeExecData.inputGroups).length;
  const outputGroups = nodeExecData.output || {};
  const outputGroupCount = Object.keys(outputGroups).length;
  let hasAnyError = false;

  function hasInnerError(array) {
    for (const dict of array) {
      if (dict.hasOwnProperty('_error')) {
        return true;
      }
    }
    return false;
  }
  errorCounts = {};
  // 2. Check for errors in existing output groups
  for (const index in outputGroups) {
    for (const fieldName in outputGroups[index]) {
      if (hasInnerError(outputGroups[index][fieldName])) {
        if (errorCounts[fieldName] === undefined) {
          errorCounts[fieldName] = 1;
        } else {
          errorCounts[fieldName] += 1;
        }
        hasAnyError = true;
      }
    }
  }
  completedWithErrorCount = 0;
  for (const fieldName in errorCounts) {
    completedWithErrorCount = Math.max(
      completedWithErrorCount,
      errorCounts[fieldName],
    );
  }

  // 3. Determine Status based on counts and errors
  console.log({
    nodeId,
    outputGroupCount,
    inputGroupCount,
    completedWithErrorCount,
    hasAnyError,
    inputGroups: nodeExecData.inputGroups,
    output: nodeExecData.output,
  });

  // 3a. Critical Error State: All expected outputs are present AND all are errors
  //console.log(`${completedWithErrorCount} / ${inputGroupCount}`);
  if (
    outputGroupCount >= inputGroupCount &&
    completedWithErrorCount === inputGroupCount &&
    inputGroupCount > 0 // Ensure there were inputs expected
  ) {
    return 'error-critical';
  }

  // 3b. Any Error State: If any error was detected at any point
  if (hasAnyError) {
    return 'error';
  }

  // 3c. Completed State: All inputs processed, no errors found
  if (outputGroupCount >= inputGroupCount) {
    return 'completed';
  }

  // 3d. Processing State: Some outputs exist, but not all, and no errors found so far
  if (outputGroupCount > 0) {
    return 'processing';
  }

  // 3e. Idle/Waiting State: Input groups exist, but no outputs generated yet (and no errors)
  return 'idle';
}

function reorderObject(obj, firstKey, lastKey) {
  const orderedObject = {};
  if (obj.hasOwnProperty(firstKey)) {
    orderedObject[firstKey] = obj[firstKey];
  }
  for (const key in obj) {
    if (key !== firstKey && key !== lastKey && obj.hasOwnProperty(key)) {
      orderedObject[key] = obj[key];
    }
  }
  if (obj.hasOwnProperty(lastKey)) {
    orderedObject[lastKey] = obj[lastKey];
  }
  return orderedObject;
}

function showInspectionBox(items, handlerElement) {
  closeInspectionBox(); // Clear any existing inspection box

  currentInspectionBox = document.createElement('div');
  currentInspectionBox.id = 'inspection-box';

  const closeButton = document.createElement('button');
  closeButton.id = 'inspection-box-close';
  closeButton.innerHTML = '&times;';
  closeButton.onclick = closeInspectionBox;
  currentInspectionBox.appendChild(closeButton);

  const contentDiv = document.createElement('div');
  contentDiv.id = 'inspection-box-content';

  if (
    !items ||
    items.length === 0 ||
    (items.length === 1 && items[0].message)
  ) {
    const p = document.createElement('p');
    p.textContent =
      (items && items[0]?.message) || 'No data available for this selection.';
    contentDiv.appendChild(p);
  } else {
    items.forEach((item, index) => {
      item = reorderObject(item, 'file', 'url');
      const itemDiv = document.createElement('div');
      itemDiv.classList.add('inspection-item');
      if (typeof item === 'object' && item !== null) {
        for (const key in item) {
          const p = document.createElement('p');
          const strongLabel = document.createElement('strong');
          if (key === 'url') {
            const a = document.createElement('a');
            a.href = item[key];
            a.textContent = 'Content:';
            a.target = '_blank';
            strongLabel.appendChild(a);
            p.appendChild(strongLabel);
          } else {
            strongLabel.textContent = `${key}: `;
            p.appendChild(strongLabel);
          }

          const value = item[key];
          if (key === 'url' && typeof value === 'string') {
            const extension = getFileExtension(item.file || value);
            if (['txt', 'json'].includes(extension)) {
              const iframeBox = document.createElement('div');
              iframeBox.style.cssText =
                'border: 1px solid #ddd; padding: 0; min-height: 100px; max-height: 150px; overflow: hidden;';
              const iframe = document.createElement('iframe');
              iframe.src = value;
              iframe.style.cssText = 'width: 100%; height: 100%; border: none;';
              // Sandbox for security, though may be restrictive for some GCS content if not plain text/json.
              iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
              iframe.onerror = () => {
                iframeBox.innerHTML =
                  '<p style="color:red;">Error: Could not load content in iframe. Check browser console.</p>';
              };
              iframeBox.appendChild(iframe);
              p.appendChild(iframeBox);
            } else if (
              ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)
            ) {
              const img = document.createElement('img');
              img.src = value;
              img.style.cssText =
                'height: 100px; display: block; margin-top: 5px;';
              img.alt = item.file || 'Image thumbnail';
              p.appendChild(img);
            } else if (extension === 'mp4') {
              const video = document.createElement('video');
              video.src = value;
              video.controls = true;
              video.style.cssText =
                'max-width: 200px; max-height: 150px; display: block; margin-top: 5px;';
              p.appendChild(video);
            }
          } else if (key === 'file' && typeof value === 'string') {
            const {gcsBucket, gcpProject} = workflow.workflowParams || {};
            if (gcsBucket && gcpProject && value.trim() !== '') {
              const lastSlash = value.lastIndexOf('/');
              const fileName =
                lastSlash !== -1 ? value.substring(lastSlash + 1) : value;
              const folderPath =
                lastSlash !== -1 ? value.substring(0, lastSlash + 1) : '';

              let displayFolderPath = folderPath;
              if (folderPath && folderPath !== '/') {
                const components = folderPath.slice(0, -1).split('/');
                displayFolderPath =
                  components.map(c => (c.length > 15 ? '...' : c)).join('/') +
                  '/';
              } else if (!folderPath) {
                displayFolderPath = '/'; // Root folder display
              }

              const gcsFolderUrl = `https://console.cloud.google.com/storage/browser/${gcsBucket}/${folderPath}?project=${gcpProject}`;
              const folderLink = document.createElement('a');
              folderLink.href = gcsFolderUrl;
              folderLink.target = '_blank';
              folderLink.textContent = displayFolderPath;
              p.appendChild(folderLink);
              p.appendChild(document.createTextNode(fileName));
            } else {
              p.appendChild(document.createTextNode(value));
            }
          } else {
            p.appendChild(
              document.createTextNode(
                value === null
                  ? 'null'
                  : String(value).substring(0, 200) +
                      (String(value).length > 200 ? '...' : ''),
              ),
            );
          }
          itemDiv.appendChild(p);
        }
      } else {
        const p = document.createElement('p');
        p.textContent = String(item);
        itemDiv.appendChild(p);
      }
      contentDiv.appendChild(itemDiv);
      if (index < items.length - 1) {
        contentDiv.appendChild(document.createElement('hr'));
      }
    });
  }

  if (handlerElement) {
    handlerElement.classList.add('highlighted');
  }
  currentInspectionBox.appendChild(contentDiv);
  canvas.appendChild(currentInspectionBox);
  tetheredHandlerElement = handlerElement;
  positionInspectionBoxAndDrawLine(handlerElement);
}

function positionInspectionBoxAndDrawLine(handlerElement) {
  if (!currentInspectionBox || !handlerElement) return;
  // createInspectionLineSvg(); // Ensure SVG and line elements are ready

  const handlerRect = handlerElement.getBoundingClientRect();
  const boxHeight = currentInspectionBox.offsetHeight;
  const boxWidth = currentInspectionBox.offsetWidth;

  let boxTop = handlerRect.top - boxHeight - 15; // Preferred position: above handler
  let boxLeft = handlerRect.left + handlerRect.width / 2 - boxWidth / 2;

  // Adjust if out of viewport bounds
  if (boxTop < 5) boxTop = handlerRect.bottom + 15; // Move below if too close to top
  if (boxLeft < 5) boxLeft = 5;
  if (boxLeft + boxWidth > window.innerWidth - 5)
    boxLeft = window.innerWidth - boxWidth - 5;
  if (boxTop + boxHeight > window.innerHeight - 5) {
    boxTop = window.innerHeight - boxHeight - 5;
    if (boxTop < 5) boxTop = 5; // Final check if still too high
  }

  currentInspectionBox.style.top = `${boxTop}px`;
  currentInspectionBox.style.left = `${boxLeft}px`;

  const finalBoxRect = currentInspectionBox.getBoundingClientRect();
}

function closeInspectionBox() {
  if (currentInspectionBox) {
    currentInspectionBox.remove();
    currentInspectionBox = null;
  }
  if (tetheredHandlerElement) {
    tetheredHandlerElement.classList.remove('highlighted');
  }
  tetheredHandlerElement = null;
}

function handleConnectorClickForInspection(event) {
  // Avoid triggering inspection if a connection drag was just completed or in progress.
  if (draggingConnection || (event.type === 'mouseup' && sourceConnector)) {
    return;
  }
  const connectorElement = event.currentTarget;
  const {
    nodeId,
    type: connectorType,
    key: connectorKey,
  } = connectorElement.dataset;

  if (
    !executionData ||
    Object.keys(executionData).length === 0 ||
    !executionData[nodeId]
  ) {
    console.warn(`Execution data not found for node ${nodeId}`);
    showInspectionBox(
      [{message: 'Execution data not available for this node.'}],
      connectorElement,
    );
    return;
  }

  let itemsToInspect = [];
  let dataFound = false;

  const nodeExecData = executionData[nodeId];
  if (
    connectorType === 'input' &&
    nodeExecData.inputFiles &&
    nodeExecData.inputFiles[connectorKey]
  ) {
    itemsToInspect = nodeExecData.inputFiles[connectorKey];
    if (itemsToInspect.length > 0) dataFound = true;
  } else if (connectorType === 'output' && nodeExecData.output) {
    // Aggregate outputs from all execution groups for this output key
    for (const groupKey in nodeExecData.output) {
      const group = nodeExecData.output[groupKey];
      if (group && group[connectorKey] && Array.isArray(group[connectorKey])) {
        itemsToInspect = itemsToInspect.concat(group[connectorKey]);
      }
    }
    if (itemsToInspect.length > 0) dataFound = true;
  }

  if (dataFound) {
    showInspectionBox(itemsToInspect, connectorElement);
  } else {
    showInspectionBox(
      [
        {
          message: `No ${connectorType} data for '${connectorKey}' on node '${nodeId}'.`,
        },
      ],
      connectorElement,
    );
  }
  event.stopPropagation(); // Prevent triggering other listeners (e.g., node drag)
}

// Existing code in /home/uenke/RemixEngine/ui/renderWorkflow.js

function calculateLevels() {
  const levels = {};
  const wfDef = workflow.workflowDefinition;
  if (!wfDef) {
    console.error('Workflow definition is missing for level calculation.');
    return levels;
  }
  const nodeIds = Object.keys(wfDef);
  const visiting = new Set(); // For cycle detection
  const visited = new Set(); // For memoization

  function computeLevel(nodeId) {
    if (visited.has(nodeId)) return levels[nodeId];
    if (visiting.has(nodeId)) return Infinity; // Cycle detected

    visiting.add(nodeId);
    let maxInputLevel = -1; // Default for root or nodes calculated based on inputs

    if (nodeId === 'root') {
      // Root node is always level 0. maxInputLevel remains -1.
    } else if (
      wfDef[nodeId] &&
      wfDef[nodeId].input &&
      Object.keys(wfDef[nodeId].input).length > 0
    ) {
      // Node has explicit inputs, calculate level based on the maximum level of its predecessors.
      for (const inputKey in wfDef[nodeId].input) {
        const sourceInfo = wfDef[nodeId].input[inputKey];
        if (sourceInfo && sourceInfo.node) {
          if (!wfDef[sourceInfo.node]) {
            console.warn(
              `Source node ${sourceInfo.node} for ${nodeId}.${inputKey} not found. Assuming level -1 for it.`,
            );
            continue;
          }
          const sourceLevel = computeLevel(sourceInfo.node);
          if (sourceLevel === Infinity) {
            // Propagate cycle detection
            visiting.delete(nodeId);
            visited.add(nodeId);
            levels[nodeId] = Infinity;
            return Infinity;
          }
          if (sourceLevel > maxInputLevel) {
            maxInputLevel = sourceLevel;
          }
        }
      }
    } else {
      // Node is not root AND has no explicit inputs defined.
      // Treat it as implicitly connected to root (level 0).
      // Its level will be root's level + 1 = 0 + 1 = 1.
      maxInputLevel = 0; // Set maxInputLevel to 0 so the final level becomes 1.
    }

    visiting.delete(nodeId);
    visited.add(nodeId);

    levels[nodeId] = maxInputLevel + 1;
    return levels[nodeId];
  }

  nodeIds.forEach(nodeId => {
    if (!visited.has(nodeId)) computeLevel(nodeId);
  });

  // Handle cycles by placing them after the max finite level
  let maxFiniteLevel = 0;
  nodeIds.forEach(id => {
    if (levels[id] !== Infinity && levels[id] >= 0) {
      maxFiniteLevel = Math.max(maxFiniteLevel, levels[id]);
    }
  });

  nodeIds.forEach(nodeId => {
    if (levels[nodeId] === Infinity) {
      console.warn(
        `Node ${nodeId} was part of a cycle or an unresolvable dependency, placing it at level ${
          maxFiniteLevel + 1
        }.`,
      );
      levels[nodeId] = maxFiniteLevel + 1;
    } else if (typeof levels[nodeId] !== 'number' || levels[nodeId] < 0) {
      console.warn(
        `Node ${nodeId} couldn't be properly leveled (level: ${levels[nodeId]}), defaulting to 0.`,
      );
      levels[nodeId] = 0; // Default for unlevelable nodes
    }
  });
  return levels;
}

function getConnectorType(nodeId, connectorRole, connectorKey) {
  // connectorRole is 'input' or 'output'
  const nodeDef = workflow.workflowDefinition[nodeId];
  if (!nodeDef) {
    console.warn(`getConnectorType: Node definition not found for ${nodeId}`);
    return undefined;
  }

  // Root node's outputs are defined in its 'types' or 'input' (if 'types' is missing)
  if (nodeId === 'root' && connectorRole === 'output') {
    const sourceObject = nodeDef.types || nodeDef.input;
    if (sourceObject && sourceObject[connectorKey]) {
      // If 'types' exists, it's a string. If 'input' is used as a fallback, it might be null or an object.
      return typeof sourceObject[connectorKey] === 'string'
        ? sourceObject[connectorKey]
        : undefined;
    }
  }
  // Sink node's inputs might have types defined directly if it's a pass-through
  if (
    nodeId === 'sink' &&
    connectorRole === 'input' &&
    nodeDef.types &&
    nodeDef.types[connectorKey]
  ) {
    return nodeDef.types[connectorKey];
  }

  const actionName = nodeDef.action;
  const actionDef = actions[actionName];
  if (
    actionDef &&
    actionDef[connectorRole] &&
    actionDef[connectorRole][connectorKey]
  ) {
    return actionDef[connectorRole][connectorKey].type;
  }

  // For 'pass' actions, try to infer type from the source if it's an input being passed through
  if (actionName === 'pass' && connectorRole === 'input') {
    const sourceInfo = nodeDef.input?.[connectorKey];
    if (sourceInfo && sourceInfo.node && sourceInfo.output) {
      return getConnectorType(sourceInfo.node, 'output', sourceInfo.output);
    }
  }
  // For 'pass' action outputs (if not root/sink handled above), it's harder to infer without more context.
  // This usually means the 'pass' node acts as a direct pass-through for one of its inputs.
  // This scenario is implicitly handled if the connection is made to an input that infers its type.
  return undefined; // Fallback
}

function createOutputConnector(node, nodeId, outputKey) {
  const outputBox = document.createElement('div');
  outputBox.className = 'connector-box output'; // Use className for multiple classes
  outputBox.dataset.nodeId = nodeId;
  outputBox.dataset.type = 'output';
  outputBox.dataset.key = outputKey;
  outputBox.textContent = outputKey;
  node.appendChild(outputBox);

  outputBox.addEventListener('mousedown', event => {
    draggingConnection = true;
    sourceConnector = event.target;
    tempLine = document.createElement('div');
    tempLine.className = 'temp-connection';
    canvas.appendChild(tempLine);

    const sourceRect = sourceConnector.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const startX = sourceRect.left + sourceRect.width / 2 - canvasRect.left;
    const startY = sourceRect.bottom - canvasRect.top;

    tempLine.style.left = `${startX}px`;
    tempLine.style.top = `${startY}px`;
    tempLine.style.width = '0px'; // Initial width
    event.stopPropagation(); // Prevent node drag when starting a connection
  });
  outputBox.addEventListener('click', handleConnectorClickForInspection);
}

function createNodeElement(nodeId, nodeDef) {
  const node = document.createElement('div');
  node.className = 'node';
  node.id = nodeId;
  node.style.width = `${nodeWidth}px`;

  const status = getNodeStatus(nodeId);
  node.classList.add(`status-${status}`);

  const title = document.createElement('div');
  title.className = 'node-title';
  // Process the title to add word break opportunities before underscores
  const originalTitle = nodeDef.action || nodeId; // Fallback to nodeId if action is missing
  const processedTitle = originalTitle.replace(/_/g, '<wbr>_'); // Insert <wbr> before each '_'
  title.innerHTML = processedTitle; // Use innerHTML to render the <wbr> tag
  node.appendChild(title);

  const actionName = nodeDef.action;
  const actionDef = actions[actionName];

  // Handle inputs
  if (actionName === 'pass' && nodeId === 'sink' && nodeDef.input) {
    Object.keys(nodeDef.input).forEach(key =>
      addInputConnector(node, nodeId, key),
    );
  } else if (actionDef && actionDef.input) {
    Object.keys(actionDef.input).forEach(key =>
      addInputConnector(node, nodeId, key),
    );
  }

  // Handle outputs
  if (actionName === 'pass' && nodeId === 'root') {
    const outputsSource = nodeDef.types || nodeDef.input; // 'types' preferred, fallback to 'input' keys for root
    if (outputsSource) {
      Object.keys(outputsSource).forEach(key =>
        createOutputConnector(node, nodeId, key),
      );
    }
  } else if (actionDef && actionDef.output) {
    Object.keys(actionDef.output).forEach(key =>
      createOutputConnector(node, nodeId, key),
    );
  }

  canvas.appendChild(node);
  return node;
}

function addInputConnector(node, nodeId, inputKey) {
  const inputBox = document.createElement('div');
  inputBox.className = 'connector-box input';
  inputBox.dataset.nodeId = nodeId;
  inputBox.dataset.type = 'input';
  inputBox.dataset.key = inputKey;
  inputBox.textContent = inputKey;
  node.appendChild(inputBox);
  inputBox.addEventListener('click', handleConnectorClickForInspection);
}

function positionNodeConnectors(node) {
  const currentNodeWidth = node.offsetWidth;
  const inputConnectors = Array.from(
    node.querySelectorAll('.connector-box.input'),
  );
  const outputConnectors = Array.from(
    node.querySelectorAll('.connector-box.output'),
  );
  const minConnectorSpacing = 4; // Minimum space between connectors

  function positionSet(connectors, isInputSet) {
    if (connectors.length === 0) return;
    let totalWidth =
      connectors.reduce((sum, box) => sum + box.offsetWidth, 0) +
      Math.max(0, connectors.length - 1) * minConnectorSpacing;
    let currentX = (currentNodeWidth - totalWidth) / 2;

    // For sink inputs, maintain order from workflowDefinition.sink.input if possible
    let sortedConnectors = connectors;
    if (
      node.id === 'sink' &&
      isInputSet &&
      workflow.workflowDefinition.sink?.input
    ) {
      const sinkInputOrder = Object.keys(
        workflow.workflowDefinition.sink.input,
      );
      sortedConnectors = sinkInputOrder
        .map(key => connectors.find(box => box.dataset.key === key))
        .filter(box => box); // Filter out undefined if a key is missing a box (should not happen)
      // Append any connectors not in sinkInputOrder (should not happen with current logic)
      connectors.forEach(box => {
        if (!sortedConnectors.includes(box)) sortedConnectors.push(box);
      });
    }

    sortedConnectors.forEach(box => {
      box.style.left = `${currentX}px`;
      currentX += box.offsetWidth + minConnectorSpacing;
    });
  }

  positionSet(inputConnectors, true);
  if (node.id !== 'sink') {
    // Sink nodes typically don't have explicit outputs in this model
    positionSet(outputConnectors, false);
  }
}

function createConnections() {
  connections = [];
  const wfDef = workflow.workflowDefinition;
  if (!wfDef) return;

  for (const nodeId in wfDef) {
    const nodeDef = wfDef[nodeId];
    if (nodeDef.input) {
      for (const inputKey in nodeDef.input) {
        const sourceInfo = nodeDef.input[inputKey];
        if (sourceInfo && sourceInfo.node && sourceInfo.output) {
          const sourceNode = nodes[sourceInfo.node];
          const targetNode = nodes[nodeId];

          if (!sourceNode || !targetNode) {
            console.warn(
              `Skipping connection: DOM element for ${sourceInfo.node} or ${nodeId} not found.`,
            );
            continue;
          }

          // Type checking for connection validity
          const sourceType = getConnectorType(
            sourceInfo.node,
            'output',
            sourceInfo.output,
          );
          const targetType = getConnectorType(nodeId, 'input', inputKey);

          if (
            targetNode.id === 'sink' ||
            true // (sourceType && targetType && sourceType === targetType)
          ) {
            connections.push({
              source: {
                node: sourceNode,
                type: 'output',
                key: sourceInfo.output,
              },
              target: {node: targetNode, type: 'input', key: inputKey},
            });
          } else {
            console.warn(
              `Type mismatch: Cannot connect ${sourceInfo.node}.${sourceInfo.output} (type: ${sourceType}) to ${nodeId}.${inputKey} (type: ${targetType}).`,
            );
          }
        }
      }
    }
  }
}

function positionNode(nodeElement, nodeDef) {
  // Position node if coordinates are defined in its definition
  if (
    nodeDef.position &&
    typeof nodeDef.position.x === 'number' &&
    typeof nodeDef.position.y === 'number'
  ) {
    nodeElement.style.left = `${nodeDef.position.x}px`;
    nodeElement.style.top = `${nodeDef.position.y}px`;
  }
}

function layoutNodes() {
  const wfDef = workflow.workflowDefinition;
  if (!wfDef) {
    console.error('Workflow definition is missing for layout.');
    return;
  }

  const levels = calculateLevels();
  if (!levels || Object.keys(levels).length === 0) {
    console.warn('No levels calculated, skipping auto-layout.');
    return;
  }

  const nodesByLevel = {};
  let maxLevel = -1;
  Object.entries(levels).forEach(([nodeId, level]) => {
    if (typeof level === 'number' && isFinite(level)) {
      if (!nodesByLevel[level]) nodesByLevel[level] = [];
      nodesByLevel[level].push(nodeId);
      maxLevel = Math.max(maxLevel, level);
    } else {
      console.warn(
        `Node ${nodeId} has an invalid level: ${level}. Skipping from auto-layout.`,
      );
    }
  });

  if (maxLevel < 0) {
    console.warn('No nodes with valid finite levels found for auto-layout.');
    return;
  }
  const estimatedNodeHeight = 120; // Approximate height for vertical spacing calculation
  const topMargin = 10,
    bottomMargin = estimatedNodeHeight,
    minHorizontalPadding = 20;
  const availableHeight = canvas.offsetHeight - topMargin - bottomMargin;

  let yPerLevel =
    maxLevel > 0 && availableHeight > estimatedNodeHeight
      ? availableHeight / maxLevel
      : estimatedNodeHeight;
  if (yPerLevel < estimatedNodeHeight + 30)
    yPerLevel = estimatedNodeHeight + 30; // Ensure minimum vertical spacing

  for (let level = 0; level <= maxLevel; level++) {
    if (nodesByLevel[level] && nodesByLevel[level].length > 0) {
      const nodesInLevel = nodesByLevel[level];
      const levelWidth =
        nodesInLevel.length * nodeWidth +
        Math.max(0, nodesInLevel.length - 1) * horizontalSpacing;
      let xOffset = (canvas.offsetWidth - levelWidth) / 2;
      if (xOffset < minHorizontalPadding) xOffset = minHorizontalPadding;

      const yOffset =
        topMargin +
        (maxLevel === 0
          ? availableHeight / 2 - estimatedNodeHeight / 2
          : level * yPerLevel);

      nodesInLevel.forEach(nodeId => {
        const nodeElement = nodes[nodeId];
        const nodeDefinition = wfDef[nodeId];
        if (nodeElement && nodeDefinition) {
          nodeElement.style.left = `${xOffset}px`;
          nodeElement.style.top = `${yOffset}px`;
          if (!nodeDefinition.position) nodeDefinition.position = {};
          nodeDefinition.position.x = xOffset;
          nodeDefinition.position.y = yOffset;
          xOffset += nodeWidth + horizontalSpacing;
        }
      });
    }
  }
}

function drawConnections() {
  requestAnimationFrame(() => {
    // Debounce drawing to improve performance
    document.querySelectorAll('.connection').forEach(line => line.remove());

    connections.forEach((connection, i) => {
      const line = document.createElement('div');
      line.className = 'connection';

      const sourceBox = connection.source.node.querySelector(
        `.connector-box.output[data-key="${connection.source.key}"]`,
      );
      const targetBox = connection.target.node.querySelector(
        `.connector-box.input[data-key="${connection.target.key}"]`,
      );

      if (!sourceBox || !targetBox) {
        console.warn(
          'Skipping draw for connection with missing connector box:',
          connection,
        );
        return;
      }

      const sourceRect = sourceBox.getBoundingClientRect();
      const targetRect = targetBox.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();

      const startX = sourceRect.left + sourceRect.width / 2 - canvasRect.left;
      const startY = sourceRect.bottom - canvasRect.top;
      const endX = targetRect.left + targetRect.width / 2 - canvasRect.left;
      const endY = targetRect.top - canvasRect.top;

      const deltaX = endX - startX;
      const deltaY = endY - startY;
      const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
      const angle = Math.atan2(deltaY, deltaX) * (180 / Math.PI);

      line.style.width = `${length}px`;
      line.style.transformOrigin = '0 0';
      line.style.transform = `rotate(${angle}deg)`;
      line.style.left = `${startX}px`;
      line.style.top = `${startY}px`;
      canvas.appendChild(line);
    });
  });
}

function updateWorkflowConnections() {
  const wfDef = workflow.workflowDefinition;
  if (!wfDef) return;

  // Clear existing input connections in the definition (except for root)
  for (const nodeId in wfDef) {
    if (nodeId !== 'root' && wfDef[nodeId]) {
      wfDef[nodeId].input = {}; // Reset inputs for non-root nodes
    }
  }
  // Rebuild input connections based on the visual 'connections' array
  connections.forEach(conn => {
    const targetNodeId = conn.target.node.id;
    const targetKey = conn.target.key;
    const sourceNodeId = conn.source.node.id;
    const sourceKey = conn.source.key;

    if (wfDef[targetNodeId]) {
      if (!wfDef[targetNodeId].input) wfDef[targetNodeId].input = {};
      wfDef[targetNodeId].input[targetKey] = {
        node: sourceNodeId,
        output: sourceKey,
      };
    }
  });
}

function handleClickOutsideInspectionBox(event) {
  if (currentInspectionBox) {
    if (currentInspectionBox.contains(event.target)) {
      return;
    }
    if (event.target.closest('.connector-box')) {
      return;
    }
    closeInspectionBox();
  }
}

function setupEventListeners() {
  let dragNode = null;
  let dragOffsetX = 0,
    dragOffsetY = 0;

  canvas.addEventListener('mousedown', event => {
    // Handle node dragging
    const clickedNodeElement = event.target.closest('.node');
    if (clickedNodeElement && !event.target.closest('.connector-box')) {
      dragNode = clickedNodeElement;
      const nodeDef = workflow.workflowDefinition[dragNode.id];
      if (!nodeDef.position)
        nodeDef.position = {
          x: dragNode.offsetLeft,
          y: dragNode.offsetTop,
        };

      dragOffsetX = event.clientX - dragNode.offsetLeft;
      dragOffsetY = event.clientY - dragNode.offsetTop;
      dragNode.style.zIndex = 10; // Bring to front while dragging
      event.stopPropagation();
    }
  });

  canvas.addEventListener('mousemove', event => {
    if (dragNode) {
      const newX = event.clientX - dragOffsetX;
      const newY = event.clientY - dragOffsetY;
      dragNode.style.left = `${newX}px`;
      dragNode.style.top = `${newY}px`;

      const nodeDef = workflow.workflowDefinition[dragNode.id];
      if (nodeDef.position) {
        // Should always exist if dragging started
        nodeDef.position.x = newX;
        nodeDef.position.y = newY;
      }
      drawConnections(); // Redraw connections as node moves

      // If inspection box is tethered to a connector on the dragged node, update its line
      if (
        currentInspectionBox &&
        tetheredHandlerElement &&
        dragNode.contains(tetheredHandlerElement)
      ) {
        requestAnimationFrame(() =>
          positionInspectionBoxAndDrawLine(tetheredHandlerElement),
        );
      }
    }
  });

  canvas.addEventListener('mouseup', event => {
    if (tempLine) tempLine.remove();
    tempLine = null;
    draggingConnection = false;
    sourceConnector = null;

    if (dragNode) {
      dragNode.style.zIndex = 'auto';
      dragNode = null;
    }
  });

  document.addEventListener('mousedown', handleClickOutsideInspectionBox);
}
