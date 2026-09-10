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

import {describe, expect, it} from 'vitest';
import {
  Candidate,
  GeneratedScene,
  PendingGeneration,
  ProvidedVideoScene,
  resolveSceneRenderClip,
} from '../services/config/config';
import {moveCandidate} from './move-candidate';

function candidate(
  runNumber: number,
  path: string,
  prompt = 'prompt',
): Candidate {
  return {
    runNumber,
    durationSeconds: 4,
    model: 'veo',
    prompt,
    generateAudio: true,
    resolution: '1080p',
    video: {path, url: `https://example.test/${path}`},
  };
}

function scene(id: string, candidates: Candidate[]): GeneratedScene {
  return {
    id,
    type: 'generated',
    name: `Scene ${id}`,
    prompt: 'scene prompt',
    candidates,
    selectedCandidateIndex: 0,
  };
}

function generated(scene: GeneratedScene | ProvidedVideoScene): GeneratedScene {
  if (!('prompt' in scene)) throw new Error('expected generated scene');
  return scene;
}

describe('moveCandidate', () => {
  it('moves a candidate into a new scene without mutating the source', () => {
    const source = scene('1', [
      candidate(2, 'a'),
      candidate(2, 'b'),
      candidate(2, 'c'),
    ]);
    source.candidates![0].isArchived = true;
    const original = source.candidates![2];
    Object.assign(original, {
      generateAudio: false,
      trim: {start: 0.5, end: 3.5},
      referenceImage: {path: 'reference.png', url: 'reference-url'},
      lowQualityThumbnail: 'data:image/png;base64,preview',
      highQualityThumbnail: {path: 'thumbnail.png', url: 'thumbnail-url'},
      editPrompt: 'Make the product brighter',
      editedFromRun: 1,
    });
    const storyboard = [source];
    const before = structuredClone(storyboard);
    const result = moveCandidate({
      storyboard,
      sourceSceneId: '1',
      candidateIndex: 2,
      expectedVideoPath: 'c',
      expectedLabel: '2C',
      destination: {kind: 'new-after-source', id: '2'},
      busySceneIds: new Set(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(storyboard[0]).toBe(source);
    expect(storyboard).toEqual(before);
    expect(result.storyboard[0]).not.toBe(source);
    expect(generated(result.storyboard[0]).candidates).toHaveLength(2);
    expect(result.storyboard[1].name).toBe('Scene 1 (2C)');
    expect(generated(result.storyboard[1]).selectedCandidateIndex).toBe(0);
    expect(generated(result.storyboard[1]).candidates?.[0].runNumber).toBe(1);
    expect(generated(result.storyboard[1]).candidates?.[0].video?.path).toBe(
      'c',
    );
    expect(generated(result.storyboard[1]).candidates?.[0].origin).toEqual({
      sceneId: '1',
      sceneName: 'Scene 1',
      runNumber: 2,
      candidateLabel: '2C',
      editedFromRun: 1,
    });
    const {editedFromRun, ...retainedFields} = original;
    expect(editedFromRun).toBe(1);
    expect(generated(result.storyboard[1]).candidates?.[0]).toEqual({
      ...retainedFields,
      runNumber: 1,
      origin: {
        sceneId: '1',
        sceneName: 'Scene 1',
        runNumber: 2,
        candidateLabel: '2C',
        editedFromRun: 1,
      },
    });
  });

  it('keeps the moved sole candidate renderable and leaves an empty source', () => {
    const source = scene('1', [candidate(1, 'only')]);
    source.generationError = 'old failure';
    source.generationErrorAcknowledged = true;
    source.prompt = 'keep prompt';
    source.referenceImage = {path: 'keep-ref', url: 'keep-ref-url'};
    const result = moveCandidate({
      storyboard: [source],
      sourceSceneId: '1',
      candidateIndex: 0,
      expectedVideoPath: 'only',
      expectedLabel: '1A',
      destination: {kind: 'new-after-source', id: '2'},
      busySceneIds: new Set(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(generated(result.storyboard[0]).candidates).toBeUndefined();
    expect(
      generated(result.storyboard[0]).selectedCandidateIndex,
    ).toBeUndefined();
    expect(generated(result.storyboard[0]).prompt).toBe('keep prompt');
    expect(generated(result.storyboard[0]).referenceImage?.path).toBe(
      'keep-ref',
    );
    expect(generated(result.storyboard[0]).generationError).toBeUndefined();
    expect(resolveSceneRenderClip(result.storyboard[0])).toEqual({
      state: 'not-selected',
    });
    expect(resolveSceneRenderClip(result.storyboard[1])).toMatchObject({
      state: 'ready',
    });
  });

  it('appends to an existing destination and preserves its selection', () => {
    const source = scene('1', [candidate(1, 'source')]);
    const destination = scene('2', [
      candidate(4, 'dest'),
      candidate(9, 'archived'),
    ]);
    destination.candidates![1].isArchived = true;
    destination.selectedCandidateIndex = 0;
    destination.prompt = 'keep this prompt';
    destination.referenceImage = {path: 'ref', url: 'ref-url'};
    destination.transition = 'fade';
    destination.transitionOverlap = 0.25;
    const result = moveCandidate({
      storyboard: [source, destination],
      sourceSceneId: '1',
      candidateIndex: 0,
      expectedVideoPath: 'source',
      expectedLabel: '1A',
      destination: {kind: 'existing', sceneId: '2'},
      busySceneIds: new Set(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const movedDestination = generated(result.storyboard[1]);
    expect(movedDestination.candidates).toHaveLength(3);
    expect(movedDestination.candidates?.[2].runNumber).toBe(10);
    expect(movedDestination.selectedCandidateIndex).toBe(0);
    expect(movedDestination.prompt).toBe('keep this prompt');
    expect(movedDestination.referenceImage?.path).toBe('ref');
    expect(movedDestination.transitionOverlap).toBe(0.25);
  });

  it('shifts a later source selection while preserving source setup', () => {
    const source = scene('1', [candidate(1, 'move'), candidate(1, 'keep')]);
    source.selectedCandidateIndex = 1;
    source.prompt = 'authored prompt';
    source.referenceImage = {path: 'source-ref', url: 'source-ref-url'};
    source.transition = 'fade';
    source.transitionOverlap = 0.2;
    const result = moveCandidate({
      storyboard: [source],
      sourceSceneId: '1',
      candidateIndex: 0,
      expectedVideoPath: 'move',
      expectedLabel: '1A',
      destination: {kind: 'new-after-source', id: '2'},
      busySceneIds: new Set(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const remaining = generated(result.storyboard[0]);
    expect(remaining.selectedCandidateIndex).toBe(0);
    expect(remaining.prompt).toBe('authored prompt');
    expect(remaining.referenceImage?.path).toBe('source-ref');
    expect(remaining.transitionOverlap).toBe(0.2);
  });

  it('selects an arrival only when the existing destination is unselected', () => {
    const source = scene('1', [candidate(1, 'source')]);
    const destination = scene('2', [candidate(3, 'dest')]);
    delete destination.selectedCandidateIndex;
    const result = moveCandidate({
      storyboard: [source, destination],
      sourceSceneId: '1',
      candidateIndex: 0,
      expectedVideoPath: 'source',
      expectedLabel: '1A',
      destination: {kind: 'existing', sceneId: '2'},
      busySceneIds: new Set(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(generated(result.storyboard[1]).selectedCandidateIndex).toBe(1);
  });

  it('preserves first-placement origin across repeated moves and return', () => {
    const source = scene('1', [candidate(1, 'source')]);
    const first = moveCandidate({
      storyboard: [source],
      sourceSceneId: '1',
      candidateIndex: 0,
      expectedVideoPath: 'source',
      expectedLabel: '1A',
      destination: {kind: 'new-after-source', id: '2'},
      busySceneIds: new Set(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = moveCandidate({
      storyboard: first.storyboard,
      sourceSceneId: '2',
      candidateIndex: 0,
      expectedVideoPath: 'source',
      expectedLabel: '1A',
      destination: {kind: 'new-after-source', id: '3'},
      busySceneIds: new Set(),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(generated(second.storyboard[2]).candidates?.[0].origin).toEqual(
      generated(first.storyboard[1]).candidates?.[0].origin,
    );
    const returned = moveCandidate({
      storyboard: second.storyboard,
      sourceSceneId: '3',
      candidateIndex: 0,
      expectedVideoPath: 'source',
      expectedLabel: '1A',
      destination: {kind: 'existing', sceneId: '1'},
      busySceneIds: new Set(),
    });
    expect(returned.ok).toBe(true);
    if (!returned.ok) return;
    expect(generated(returned.storyboard[0]).candidates?.[0]).toEqual(
      generated(first.storyboard[1]).candidates?.[0],
    );
    expect(generated(returned.storyboard[0]).prompt).toBe(source.prompt);
    expect(generated(returned.storyboard[2]).candidates).toBeUndefined();
    expect(
      moveCandidate({
        storyboard: first.storyboard,
        sourceSceneId: '1',
        candidateIndex: 0,
        expectedVideoPath: 'source',
        expectedLabel: '1A',
        destination: {kind: 'new-after-source', id: '2'},
        busySceneIds: new Set(),
      }),
    ).toEqual({ok: false, reason: 'invalid-source'});
  });

  it('rejects stale, same-scene, and busy moves without changing the input', () => {
    const source = scene('1', [candidate(1, 'source')]);
    const storyboard = [source];
    expect(
      moveCandidate({
        storyboard,
        sourceSceneId: '1',
        candidateIndex: 0,
        expectedVideoPath: 'other',
        expectedLabel: '1A',
        destination: {kind: 'new-after-source', id: '2'},
        busySceneIds: new Set(),
      }),
    ).toEqual({ok: false, reason: 'invalid-source'});
    expect(
      moveCandidate({
        storyboard,
        sourceSceneId: '1',
        candidateIndex: 0,
        expectedVideoPath: 'source',
        expectedLabel: '1A',
        destination: {kind: 'existing', sceneId: '1'},
        busySceneIds: new Set(),
      }),
    ).toEqual({ok: false, reason: 'invalid-destination'});
    expect(
      moveCandidate({
        storyboard,
        sourceSceneId: '1',
        candidateIndex: 0,
        expectedVideoPath: 'source',
        expectedLabel: '1A',
        destination: {kind: 'new-after-source', id: '2'},
        busySceneIds: new Set(['1']),
      }),
    ).toEqual({ok: false, reason: 'busy'});
    expect(storyboard[0]).toBe(source);
  });

  it('rejects pending scenes and ineligible or stale candidates', () => {
    const source = scene('1', [candidate(1, 'source')]);
    const destination = scene('2', []);
    const pending: PendingGeneration = {
      executionId: 'run',
      requestedCount: 1,
      startedAt: new Date(0).toISOString(),
      durationSeconds: 4,
      model: 'veo',
      generateAudio: true,
      resolution: '1080p',
      prompt: source.prompt,
    };
    source.pendingGeneration = pending;
    const input = {
      storyboard: [source, destination],
      sourceSceneId: '1',
      candidateIndex: 0,
      expectedVideoPath: 'source',
      expectedLabel: '1A',
      destination: {kind: 'existing' as const, sceneId: '2'},
      busySceneIds: new Set<string>(),
    };
    expect(moveCandidate(input)).toEqual({ok: false, reason: 'busy'});
    delete source.pendingGeneration;
    destination.pendingGeneration = pending;
    expect(moveCandidate(input)).toEqual({ok: false, reason: 'busy'});
    delete destination.pendingGeneration;
    expect(moveCandidate({...input, busySceneIds: new Set(['2'])})).toEqual({
      ok: false,
      reason: 'busy',
    });
    expect(moveCandidate({...input, expectedLabel: '1B'})).toEqual({
      ok: false,
      reason: 'invalid-source',
    });
    source.candidates![0].isArchived = true;
    expect(moveCandidate(input)).toEqual({ok: false, reason: 'invalid-source'});
  });

  it('clears a removed selection and preserves an undefined selection', () => {
    const source = scene('1', [candidate(1, 'a'), candidate(1, 'b')]);
    const input = {
      storyboard: [source],
      sourceSceneId: '1',
      candidateIndex: 0,
      expectedVideoPath: 'a',
      expectedLabel: '1A',
      destination: {kind: 'new-after-source' as const, id: '2'},
      busySceneIds: new Set<string>(),
    };
    const selectedResult = moveCandidate(input);
    expect(selectedResult.ok).toBe(true);
    if (!selectedResult.ok) return;
    expect(
      generated(selectedResult.storyboard[0]).selectedCandidateIndex,
    ).toBeUndefined();
    expect(
      generated(selectedResult.storyboard[0]).candidates?.[0].video?.path,
    ).toBe('b');
    delete source.selectedCandidateIndex;
    const unselectedResult = moveCandidate(input);
    expect(unselectedResult.ok).toBe(true);
    if (!unselectedResult.ok) return;
    expect(
      generated(unselectedResult.storyboard[0]).selectedCandidateIndex,
    ).toBeUndefined();
  });

  it('rejects empty-path and error candidates', () => {
    for (const mutate of [
      (item: Candidate) => (item.video = {path: '', url: 'legacy'}),
      (item: Candidate) => (item.errorMessage = 'failed'),
    ]) {
      const source = scene('1', [candidate(1, 'source')]);
      mutate(source.candidates![0]);
      expect(
        moveCandidate({
          storyboard: [source],
          sourceSceneId: '1',
          candidateIndex: 0,
          expectedVideoPath: source.candidates![0].video?.path ?? '',
          expectedLabel: '1A',
          destination: {kind: 'new-after-source', id: '2'},
          busySceneIds: new Set(),
        }),
      ).toEqual({ok: false, reason: 'invalid-source'});
    }
  });

  it('rejects duplicate fresh IDs and provided-video destinations', () => {
    const source = scene('1', [candidate(1, 'source')]);
    const provided: ProvidedVideoScene = {
      id: '3',
      type: 'video',
      name: 'Video',
    };
    const base = {
      storyboard: [source, provided],
      sourceSceneId: '1',
      candidateIndex: 0,
      expectedVideoPath: 'source',
      expectedLabel: '1A',
      busySceneIds: new Set<string>(),
    };
    expect(
      moveCandidate({
        ...base,
        destination: {kind: 'new-after-source', id: '3'},
      }),
    ).toEqual({
      ok: false,
      reason: 'invalid-destination',
    });
    expect(
      moveCandidate({...base, destination: {kind: 'existing', sceneId: '3'}}),
    ).toEqual({
      ok: false,
      reason: 'invalid-destination',
    });
  });
});
