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

import {
  Candidate,
  CandidateOrigin,
  GeneratedScene,
  ProvidedVideoScene,
} from '../services/config/config';

type StoryboardScene = GeneratedScene | ProvidedVideoScene;

export type MoveDestination =
  | {kind: 'new-after-source'; id: string}
  | {kind: 'existing'; sceneId: string};

export interface MoveCandidateInput {
  storyboard: readonly StoryboardScene[];
  sourceSceneId: string;
  candidateIndex: number;
  expectedVideoPath: string;
  expectedLabel: string;
  destination: MoveDestination;
  busySceneIds: ReadonlySet<string>;
}

export type MoveCandidateResult =
  | {ok: true; storyboard: StoryboardScene[]; destinationSceneId: string}
  | {ok: false; reason: 'invalid-source' | 'invalid-destination' | 'busy'};

/** Uses the same full-array, run-local lettering as the storyboard chips. */
export function candidateLabel(
  candidates: readonly Candidate[],
  candidateIndex: number,
): string | undefined {
  const candidate = candidates[candidateIndex];
  if (!candidate) return undefined;
  const ordinal = candidates
    .slice(0, candidateIndex)
    .filter(c => c.runNumber === candidate.runNumber).length;
  return `${candidate.runNumber}${String.fromCharCode(65 + ordinal)}`;
}

function cloneMovedCandidate(
  candidate: Candidate,
  source: GeneratedScene,
  label: string,
): Candidate {
  const moved = structuredClone(candidate);
  if (!moved.origin) {
    const origin: CandidateOrigin = {
      sceneId: source.id,
      sceneName: source.name,
      runNumber: candidate.runNumber,
      candidateLabel: label,
    };
    if (candidate.editedFromRun !== undefined) {
      origin.editedFromRun = candidate.editedFromRun;
    }
    moved.origin = origin;
  }
  delete moved.editedFromRun;
  return moved;
}

export function moveCandidate(input: MoveCandidateInput): MoveCandidateResult {
  const sourceIndex = input.storyboard.findIndex(
    scene => scene.id === input.sourceSceneId,
  );
  const source = input.storyboard[sourceIndex];
  if (!source || !isGenerated(source)) {
    return {ok: false, reason: 'invalid-source'};
  }
  if (!Number.isInteger(input.candidateIndex) || input.candidateIndex < 0) {
    return {ok: false, reason: 'invalid-source'};
  }
  const candidate = source.candidates?.[input.candidateIndex];
  if (
    !candidate ||
    !candidate.video?.path ||
    candidate.video.path !== input.expectedVideoPath ||
    candidate.isArchived ||
    candidate.errorMessage ||
    candidateLabel(source.candidates ?? [], input.candidateIndex) !==
      input.expectedLabel
  ) {
    return {ok: false, reason: 'invalid-source'};
  }

  const destinationSceneId =
    input.destination.kind === 'existing'
      ? input.destination.sceneId
      : input.destination.id;
  if (destinationSceneId === source.id) {
    return {ok: false, reason: 'invalid-destination'};
  }
  if (
    source.pendingGeneration ||
    input.busySceneIds.has(source.id) ||
    (input.destination.kind === 'existing' &&
      (input.busySceneIds.has(destinationSceneId) ||
        hasPendingGeneration(input.storyboard, destinationSceneId)))
  ) {
    return {ok: false, reason: 'busy'};
  }
  if (input.destination.kind === 'new-after-source') {
    if (input.storyboard.some(scene => scene.id === destinationSceneId)) {
      return {ok: false, reason: 'invalid-destination'};
    }
  }
  const destinationIndex = input.storyboard.findIndex(
    scene => scene.id === destinationSceneId,
  );
  if (
    input.destination.kind === 'existing' &&
    (destinationIndex < 0 || !isGenerated(input.storyboard[destinationIndex]))
  ) {
    return {ok: false, reason: 'invalid-destination'};
  }

  const moved = cloneMovedCandidate(candidate, source, input.expectedLabel);
  const remaining = source.candidates?.filter(
    (_candidate, index) => index !== input.candidateIndex,
  );
  const updatedSource: GeneratedScene = {...source};
  if (!remaining?.length) {
    delete updatedSource.candidates;
    delete updatedSource.selectedCandidateIndex;
    delete updatedSource.generationError;
    delete updatedSource.generationErrorAcknowledged;
  } else {
    updatedSource.candidates = remaining;
    if (source.selectedCandidateIndex === input.candidateIndex) {
      delete updatedSource.selectedCandidateIndex;
    } else if (
      source.selectedCandidateIndex !== undefined &&
      source.selectedCandidateIndex > input.candidateIndex
    ) {
      updatedSource.selectedCandidateIndex = source.selectedCandidateIndex - 1;
    }
  }

  const next = input.storyboard.map((scene, index) =>
    index === sourceIndex ? updatedSource : scene,
  );
  if (input.destination.kind === 'new-after-source') {
    const destination: GeneratedScene = {
      id: destinationSceneId,
      type: 'generated',
      name: `${source.name} (${input.expectedLabel})`,
      prompt: moved.prompt,
      referenceImage: moved.referenceImage,
      candidates: [{...moved, runNumber: 1}],
      selectedCandidateIndex: 0,
    };
    next.splice(sourceIndex + 1, 0, destination);
  } else {
    const destination = next[destinationIndex];
    if (!isGenerated(destination)) {
      return {ok: false, reason: 'invalid-destination'};
    }
    const candidates = destination.candidates ?? [];
    const runNumber = candidates.length
      ? Math.max(...candidates.map(item => item.runNumber)) + 1
      : 1;
    next[destinationIndex] = {
      ...destination,
      candidates: [...candidates, {...moved, runNumber}],
      ...(destination.selectedCandidateIndex === undefined
        ? {selectedCandidateIndex: candidates.length}
        : {}),
    };
  }
  return {ok: true, storyboard: next, destinationSceneId};
}

function isGenerated(
  scene: StoryboardScene | undefined,
): scene is GeneratedScene {
  return scene?.type === 'generated';
}

function hasPendingGeneration(
  storyboard: readonly StoryboardScene[],
  sceneId: string,
): boolean {
  const scene = storyboard.find(item => item.id === sceneId);
  return isGenerated(scene) && scene.pendingGeneration !== undefined;
}
