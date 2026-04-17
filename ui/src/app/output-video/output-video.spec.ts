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

import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {ConfigService} from '../services/config/config';
import {OutputVideo} from './output-video';

describe('OutputVideo', () => {
  let component: OutputVideo;
  let fixture: ComponentFixture<OutputVideo>;

  beforeEach(async () => {
    const configServiceMock = {
      projectConfig: {
        value: () => ({
          title: 'Test Project',
          outputVideoUrl: 'http://test.com/video.mp4',
        }),
      },
    };

    await TestBed.configureTestingModule({
      imports: [OutputVideo],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {provide: ConfigService, useValue: configServiceMock},
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(OutputVideo);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
