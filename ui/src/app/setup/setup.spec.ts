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

import {HarnessLoader} from '@angular/cdk/testing';
import {TestbedHarnessEnvironment} from '@angular/cdk/testing/testbed';
import {signal, type WritableSignal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {MatSelectHarness} from '@angular/material/select/testing';
import {MatSlider} from '@angular/material/slider';
import {MatSnackBar} from '@angular/material/snack-bar';
import {By} from '@angular/platform-browser';
import {provideRouter} from '@angular/router';
import {RouterTestingHarness} from '@angular/router/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {routes} from '../app.routes';
import {ClientMediaService} from '../services/client-media/client-media';
import {ConfigService, ProjectConfig} from '../services/config/config';
import {ImageImportService} from '../services/image-import/image-import';
import {RemixEngineService} from '../services/remix-engine/remix-engine';
import {TemplatesService} from '../services/templates/templates';
import {Setup} from './setup';

describe('Setup', () => {
  let component: Setup;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Setup],
      providers: [provideRouter(routes)],
    }).compileComponents();

    const harness = await RouterTestingHarness.create();
    component = await harness.navigateByUrl('/abc123/setup', Setup);
    harness.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('Setup image upload', () => {
  let component: Setup;
  let configMock: {
    projectConfig: {value: ReturnType<typeof signal<Partial<ProjectConfig>>>};
    updateProjectConfig: ReturnType<typeof vi.fn>;
    saveNow: ReturnType<typeof vi.fn>;
    videoModels: () => string[];
  };
  let remixMock: {uploadMedia: ReturnType<typeof vi.fn>};
  let clientMediaMock: {convertImage: ReturnType<typeof vi.fn>};
  let imageImportMock: {
    importText: ReturnType<typeof vi.fn>;
    imageFilesFromDataTransfer: ReturnType<typeof vi.fn>;
    imageUrlFromDataTransfer: ReturnType<typeof vi.fn>;
    isEditableTarget: ReturnType<typeof vi.fn>;
  };
  let snackBarMock: {open: ReturnType<typeof vi.fn>};

  beforeEach(async () => {
    const projectConfig = signal<Partial<ProjectConfig>>({
      id: 'proj-1',
      inputConfig: {
        products: [{id: 1, name: 'Product 1', images: []}],
        composition: '',
        style: '',
        audience: '',
      },
    });
    configMock = {
      projectConfig: {value: projectConfig},
      // Mirror the real updateProjectConfig signal merge so processFiles'
      // reads of the latest value behave like production.
      updateProjectConfig: vi.fn((partial: Partial<ProjectConfig>) =>
        projectConfig.update(c => ({...c, ...partial})),
      ),
      saveNow: vi.fn(),
      // The template's model dropdown reads this.
      videoModels: () => [],
    };
    remixMock = {
      uploadMedia: vi
        .fn()
        .mockResolvedValue({path: 'remix-input/x', url: 'https://x'}),
    };
    clientMediaMock = {
      convertImage: vi.fn().mockResolvedValue(
        new Blob(['converted'], {
          type: 'image/jpeg',
        }),
      ),
    };
    imageImportMock = {
      importText: vi.fn().mockResolvedValue({files: [], failures: []}),
      imageFilesFromDataTransfer: vi.fn().mockReturnValue([]),
      imageUrlFromDataTransfer: vi.fn().mockReturnValue(null),
      isEditableTarget: vi.fn().mockReturnValue(false),
    };
    snackBarMock = {open: vi.fn()};

    TestBed.configureTestingModule({
      imports: [Setup],
      providers: [
        provideRouter(routes),
        {provide: ConfigService, useValue: configMock},
        {provide: RemixEngineService, useValue: remixMock},
        {provide: ClientMediaService, useValue: clientMediaMock},
        {provide: ImageImportService, useValue: imageImportMock},
      ],
    });
    // Swap the template for an empty one: this test exercises the
    // processFiles() class logic only, so the full markup (which reads many
    // ConfigService members not on this focused mock) must not render.
    TestBed.overrideComponent(Setup, {set: {template: ''}});
    TestBed.overrideProvider(MatSnackBar, {useValue: snackBarMock});
    await TestBed.compileComponents();

    const fixture = TestBed.createComponent(Setup);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('persists immediately once after an image upload resolves', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'pic.jpeg', {
      type: 'image/jpeg',
    });

    const result = await component.processFiles(1, [
      file,
    ] as unknown as FileList);

    expect(remixMock.uploadMedia).toHaveBeenCalledTimes(1);
    // The uploaded image was recorded on the product...
    expect(configMock.updateProjectConfig).toHaveBeenCalledTimes(1);
    expect(
      configMock.projectConfig.value().inputConfig?.products[0].images,
    ).toEqual([{path: 'remix-input/x', url: 'https://x', name: 'pic.jpeg'}]);
    // ...and persisted right away exactly once (the discrete upload event).
    expect(configMock.saveNow).toHaveBeenCalledTimes(1);
    // saveNow runs after the config update that recorded the new image.
    expect(configMock.saveNow.mock.invocationCallOrder[0]).toBeGreaterThan(
      configMock.updateProjectConfig.mock.invocationCallOrder[0],
    );
    expect(result).toEqual({added: 1, failures: []});
  });

  it('keeps successful uploads in input order when a sibling upload fails', async () => {
    const files = ['a.jpeg', 'b.jpeg', 'c.jpeg'].map(
      name => new File([name], name, {type: 'image/jpeg'}),
    );
    let resolveFirstUpload!: (value: {path: string; url: string}) => void;
    let resolveThirdUpload!: (value: {path: string; url: string}) => void;
    remixMock.uploadMedia.mockImplementation((file: File) => {
      if (file.name === 'a.jpeg') {
        return new Promise(resolve => {
          resolveFirstUpload = resolve;
        });
      }
      if (file.name === 'b.jpeg') {
        return Promise.reject(new Error('upload failed'));
      }
      return new Promise(resolve => {
        resolveThirdUpload = resolve;
      });
    });

    const completion = component.processFiles(1, files);
    await vi.waitFor(() => {
      expect(remixMock.uploadMedia).toHaveBeenCalledTimes(3);
    });
    resolveThirdUpload({
      path: 'remix-input/c.jpeg',
      url: 'https://c.jpeg',
    });
    await Promise.resolve();
    resolveFirstUpload({
      path: 'remix-input/a.jpeg',
      url: 'https://a.jpeg',
    });
    const result = await completion;

    expect(
      configMock.projectConfig.value().inputConfig?.products[0].images,
    ).toEqual([
      {
        path: 'remix-input/a.jpeg',
        url: 'https://a.jpeg',
        name: 'a.jpeg',
      },
      {
        path: 'remix-input/c.jpeg',
        url: 'https://c.jpeg',
        name: 'c.jpeg',
      },
    ]);
    expect(result).toEqual({
      added: 2,
      failures: [{source: 'b.jpeg', reason: 'upload failed'}],
    });
    expect(component.failuresFor(1)).toEqual([
      {source: 'b.jpeg', reason: 'upload failed'},
    ]);
    expect(configMock.updateProjectConfig).toHaveBeenCalledTimes(1);
    expect(configMock.saveNow).toHaveBeenCalledTimes(1);
    expect(snackBarMock.open).toHaveBeenCalledWith(
      '2 images added. 1 could not be added.',
      'Close',
      {duration: 6000},
    );
  });

  it('keeps valid siblings when another file exceeds the size limit', async () => {
    const oversized = new File(['large'], 'too-large.jpeg', {
      type: 'image/jpeg',
    });
    Object.defineProperty(oversized, 'size', {
      value: component.MAX_FILE_SIZE_BYTES + 1,
    });
    const valid = new File(['valid'], 'valid.jpeg', {type: 'image/jpeg'});

    const result = await component.processFiles(1, [oversized, valid]);

    expect(remixMock.uploadMedia).toHaveBeenCalledTimes(1);
    expect(remixMock.uploadMedia).toHaveBeenCalledWith(valid);
    expect(result).toEqual({
      added: 1,
      failures: [
        {
          source: 'too-large.jpeg',
          reason: `File exceeds the ${component.MAX_FILE_SIZE_MB}MB limit`,
        },
      ],
    });
    expect(
      configMock.projectConfig.value().inputConfig?.products[0].images,
    ).toEqual([{path: 'remix-input/x', url: 'https://x', name: 'valid.jpeg'}]);
    expect(configMock.saveNow).toHaveBeenCalledTimes(1);
    expect(snackBarMock.open).toHaveBeenCalledWith(
      '1 image added. 1 could not be added.',
      'Close',
      {duration: 6000},
    );
  });

  it('does not update or save when every file fails', async () => {
    const files = [
      new File(['text'], 'notes.txt', {type: 'text/plain'}),
      new File(['image'], 'broken.jpeg', {type: 'image/jpeg'}),
    ];
    remixMock.uploadMedia.mockRejectedValue(new Error('storage unavailable'));

    const result = await component.processFiles(1, files);

    expect(result).toEqual({
      added: 0,
      failures: [
        {source: 'notes.txt', reason: 'File is not an image'},
        {source: 'broken.jpeg', reason: 'storage unavailable'},
      ],
    });
    expect(configMock.updateProjectConfig).not.toHaveBeenCalled();
    expect(configMock.saveNow).not.toHaveBeenCalled();
    expect(snackBarMock.open).toHaveBeenCalledWith(
      '0 images added. 2 could not be added.',
      'Close',
      {duration: 6000},
    );
  });

  it('settles conversion failures without dropping other uploads', async () => {
    const files = [
      new File(['webp'], 'broken.webp', {type: 'image/webp'}),
      new File(['jpeg'], 'working.jpeg', {type: 'image/jpeg'}),
    ];
    clientMediaMock.convertImage.mockRejectedValue(
      new Error('conversion failed'),
    );

    const result = await component.processFiles(1, files);

    expect(result).toEqual({
      added: 1,
      failures: [{source: 'broken.webp', reason: 'conversion failed'}],
    });
    expect(
      configMock.projectConfig.value().inputConfig?.products[0].images,
    ).toEqual([
      {
        path: 'remix-input/x',
        url: 'https://x',
        name: 'working.jpeg',
      },
    ]);
    expect(configMock.saveNow).toHaveBeenCalledTimes(1);
  });

  it('keeps link import busy until uploads settle and reports both failure stages', async () => {
    const successfulFile = new File(['ok'], 'ok.jpeg', {type: 'image/jpeg'});
    const failedFile = new File(['bad'], 'bad.jpeg', {type: 'image/jpeg'});
    imageImportMock.importText.mockResolvedValue({
      files: [successfulFile, failedFile],
      failures: [{source: 'bad-link', reason: 'could not be downloaded'}],
    });
    let resolveUpload!: (value: {path: string; url: string}) => void;
    remixMock.uploadMedia.mockImplementation((file: File) => {
      if (file.name === 'bad.jpeg') {
        return Promise.reject(new Error('upload failed'));
      }
      return new Promise(resolve => {
        resolveUpload = resolve;
      });
    });

    const completion = component.addImagesFromLinks(1, 'two links');
    await vi.waitFor(() => {
      expect(remixMock.uploadMedia).toHaveBeenCalledTimes(2);
    });
    const importingWhileUploadPending = component.isImporting(1);
    resolveUpload({path: 'remix-input/ok.jpeg', url: 'https://ok.jpeg'});
    await completion;

    expect(importingWhileUploadPending).toBe(true);
    expect(component.isImporting(1)).toBe(false);
    expect(component.failuresFor(1)).toEqual([
      {source: 'bad-link', reason: 'could not be downloaded'},
      {source: 'bad.jpeg', reason: 'upload failed'},
    ]);
    expect(snackBarMock.open).toHaveBeenCalledTimes(1);
    expect(snackBarMock.open).toHaveBeenCalledWith(
      'Added 1 image. 2 could not be added.',
      'Close',
      {duration: 6000},
    );
  });
});

describe('Setup video controls', () => {
  let component: Setup;
  let fixture: ComponentFixture<Setup>;
  let loader: HarnessLoader;
  let projectConfigSignal: WritableSignal<ProjectConfig>;
  let configMock: {
    projectConfig: {
      value: WritableSignal<ProjectConfig>;
      isLoading: () => boolean;
      error: () => null;
    };
    updateProjectConfig: ReturnType<typeof vi.fn>;
    saveNow: ReturnType<typeof vi.fn>;
    videoModels: () => string[];
    audioLocked: () => boolean;
    allowedResolutions: ReturnType<typeof vi.fn>;
    allowedAspectRatios: ReturnType<typeof vi.fn>;
    durationSlider: ReturnType<typeof vi.fn>;
    selectResolution: ReturnType<typeof vi.fn>;
    selectVideoModel: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    projectConfigSignal = signal<ProjectConfig>({
      id: 'proj-1',
      name: 'Test Project',
      aspectRatio: '16:9',
      resolution: '1080p',
      candidateDurationSeconds: 6,
      generateAudio: false,
      numberOfCandidates: 1,
      model: 'veo-default',
      inputConfig: {
        products: [{id: 1, name: 'Product 1', images: []}],
        composition: '',
        style: '',
        audience: '',
        templateId: 'custom',
      },
      storyboard: [],
      audioTracks: [],
      visualOverlays: [],
    });
    configMock = {
      projectConfig: {
        value: projectConfigSignal,
        isLoading: () => false,
        error: () => null,
      },
      updateProjectConfig: vi.fn((partial: Partial<ProjectConfig>) =>
        projectConfigSignal.update(c => ({...c, ...partial})),
      ),
      saveNow: vi.fn(),
      videoModels: () => ['veo-default', 'omni-1'],
      audioLocked: () => false,
      allowedResolutions: vi.fn(() => ['360p', '720p', '1080p', '4k']),
      allowedAspectRatios: vi.fn(() => ['16:9', '9:16']),
      durationSlider: vi.fn(() => ({min: 3, max: 10, step: 1})),
      selectResolution: vi.fn(),
      selectVideoModel: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [Setup],
      providers: [
        provideRouter(routes),
        {provide: ConfigService, useValue: configMock},
        {provide: RemixEngineService, useValue: {uploadMedia: vi.fn()}},
        {provide: ClientMediaService, useValue: {convertImage: vi.fn()}},
        {
          provide: ImageImportService,
          useValue: {
            importText: vi.fn(),
            imageFilesFromDataTransfer: vi.fn().mockReturnValue([]),
            imageUrlFromDataTransfer: vi.fn().mockReturnValue(null),
            isEditableTarget: vi.fn().mockReturnValue(false),
          },
        },
        {
          provide: TemplatesService,
          useValue: {templates: {value: () => undefined}},
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Setup);
    component = fixture.componentInstance;
    loader = TestbedHarnessEnvironment.loader(fixture);
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it("offers the model's allowed resolutions, labeling 4k as 4K", async () => {
    const select = await loader.getHarness(
      MatSelectHarness.with({ancestor: '.resolution-select'}),
    );
    await select.open();
    const options = await select.getOptions();
    const texts = await Promise.all(options.map(o => o.getText()));

    expect(texts).toEqual(['360p', '720p', '1080p', '4K']);
  });

  it('falls back to two options when the model has no allowed_resolutions', async () => {
    configMock.allowedResolutions.mockReturnValue(['720p', '1080p']);
    fixture.detectChanges();
    const select = await loader.getHarness(
      MatSelectHarness.with({ancestor: '.resolution-select'}),
    );
    await select.open();
    const options = await select.getOptions();

    expect(options.length).toBe(2);
  });

  it('drives the duration slider from durationSlider()', () => {
    const noGapItems = fixture.debugElement.queryAll(
      By.css('.setting-item.no-gap'),
    );
    const durationSliderEl = noGapItems[1].query(By.directive(MatSlider))
      .componentInstance as MatSlider;

    expect(durationSliderEl.min).toBe(3);
    expect(durationSliderEl.max).toBe(10);
    expect(durationSliderEl.step).toBe(1);
  });

  it('calls selectVideoModel when a model is chosen', async () => {
    const select = await loader.getHarness(
      MatSelectHarness.with({ancestor: '.veo-model-select'}),
    );
    await select.open();
    await select.clickOptions({text: 'omni-1'});

    expect(configMock.selectVideoModel).toHaveBeenCalledWith('omni-1');
  });

  it('calls selectResolution when a resolution is chosen', async () => {
    const select = await loader.getHarness(
      MatSelectHarness.with({ancestor: '.resolution-select'}),
    );
    await select.open();
    await select.clickOptions({text: '360p'});

    expect(configMock.selectResolution).toHaveBeenCalledWith('360p');
  });

  it('renders an aspect ratio toggle for each allowed value', () => {
    const toggles = fixture.debugElement.queryAll(
      By.css('.aspect-ratio-setting mat-button-toggle'),
    );
    const texts = toggles.map(t => t.nativeElement.textContent.trim());

    expect(texts).toEqual(
      expect.arrayContaining([
        expect.stringContaining('16:9'),
        expect.stringContaining('9:16'),
      ]),
    );
    expect(toggles.length).toBe(2);
  });

  it('renders the aspect ratio toggles from allowedAspectRatios()', () => {
    configMock.allowedAspectRatios.mockReturnValue(['9:16']);
    fixture.detectChanges();
    const toggles = fixture.debugElement.queryAll(
      By.css('.aspect-ratio-setting mat-button-toggle'),
    );

    expect(toggles.length).toBe(1);
    expect(toggles[0].nativeElement.textContent).toContain('9:16');
    expect(
      toggles[0].query(By.css('mat-icon')).nativeElement.textContent.trim(),
    ).toBe('crop_portrait');
  });
});
