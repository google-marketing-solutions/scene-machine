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

import {ComponentFixture, TestBed} from '@angular/core/testing';
import {MatDialogRef} from '@angular/material/dialog';
import {TemplatesService} from '../../services/templates/templates';
import {TemplateDialog} from './template-dialog';

describe('TemplateDialog', () => {
  let component: TemplateDialog;
  let fixture: ComponentFixture<TemplateDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TemplateDialog],
      providers: [
        {provide: MatDialogRef, useValue: {}},
        {provide: TemplatesService, useValue: {}},
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(TemplateDialog);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
