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

import {AspectRatio, Resolution} from '../config/config';

/**
 * Represents a single scene item within a generated storyboard.
 */
export interface StoryboardItem {
  product_id: string;
  image_id: string;
  scene_name: string;
  video_prompt: string;
}

/**
 * Represents a generic node item in the workflow output, extending a
 * storyboard item.
 */
export interface NodeItem extends Partial<StoryboardItem> {
  _error?: string;
  video_variant_id?: string;
  file?: string;
  url?: string;
  [key: string]: string | number | undefined;
}

interface Node {
  actualCounts: object;
  inputFiles: object;
  inputGroups: object;
  lastUpdated: string;
  output: {
    [key: string]: {
      [key: string]: NodeItem[];
    };
  };
  targetCounts: object;
}

/**
 * Response from starting a workflow.
 */
export interface SupplyNodeResponse {
  executionId: string;
}

/**
 * Response from polling workflow status.
 */
export interface WorkflowStatusResponse {
  sink?: Node;
  [key: string]: object | Node | undefined;
}

interface CommonWorkflowParameters {
  gcpProject: string;
  gcpLocation: string;
  gcsBucket: string;
  workflowId: string;
  forceExecution: boolean;
  tasksQueuePrefix: string;
}

/**
 * Parameters for storyboard generation workflow.
 */
export interface StoryboardGenerationWorkflowParameters extends CommonWorkflowParameters {
  briefingPath?: string;
  geminiModel: string;
  imageDecision: 'none' | 'crop' | 'outpaint';
  geminiLocation: string;
  aspectRatio: AspectRatio;
  imageModel: string;
  imageLocation: string;
}

/**
 * Parameters for video generation workflow.
 */
export interface VideoGenerationWorkflowParameters extends CommonWorkflowParameters {
  numberOfVideos: number;
  videoDuration: number;
  generateAudio: boolean;
  veoModel: string;
  veoLocation: string;
  aspectRatio: string;
  productImagePath?: string;
  promptPath: string;
  resolution: Resolution;
}

/**
 * Parameters for the edit_video workflow: takes a source candidate's video
 * and a text prompt, run through the catalog's edit-capable model.
 */
export interface VideoEditWorkflowParameters extends CommonWorkflowParameters {
  model: string;
  location: string;
  videoPath: string;
  promptPath: string;
}

/**
 * Parameters for combining scenes workflow.
 */
export interface CombineScenesWorkflowParameters extends CommonWorkflowParameters {
  resolution: string;
  encodingSpeed: number;
  qualityLevel: number;
  arrangementPath: string;
}

/**
 * Arrangement for combining videos.
 */
export interface CombineVideoArrangement {
  file_type: string;
  file_path: string;
  start_time: number;
  skip_time: number;
  duration: number;
  offset_x?: number; // (for images) distance from the left, in pixels
  offset_y?: number; // (for images) distance from the top, in pixels
  width?: number; // (for images) width to be taken up, in pixels
  height?: number; // (for images) height to be taken up, in pixels
  scenes?: number[]; // (for images) list of videos in which to show this
  transition?: string;
  transition_overlap?: number;
}

/**
 * Interval for polling workflow status.
 */
export const WORKFLOW_STATUS_POLL_INTERVAL_MS = 3000;

/**
 * Overall backstop for a single workflow status poll. If the workflow's terminal
 * sink output has not arrived within this window the poll gives up with a
 * PollTimeoutError instead of spinning forever — e.g. an IAP session that never
 * recovers (every poll 401s), or a backend run that ends without ever writing
 * its sink output. Deliberately generous: legitimate multi-candidate Veo runs
 * finish well inside it. On timeout the persisted in-flight marker is KEPT, so
 * reopening the project resumes the run and still collects a late result.
 */
export const WORKFLOW_STATUS_POLL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Backoff delays between signUrl retry attempts in the candidate-collection
 * path (mediated media mode): total attempts = delays.length + 1. Exported
 * (like the poll interval above) so specs can shorten the delays.
 */
export const SIGN_URL_RETRY_DELAYS_MS = [1000, 2000];
