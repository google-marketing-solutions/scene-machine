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
  product_id: string | number;
  image_id: string | number;
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
