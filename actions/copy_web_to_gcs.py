# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Copies files from web URLs to GCS."""

from __future__ import annotations

import contextlib
import io
import mimetypes

import PIL.Image
import requests

from common import Key
from common import logger
from common import NodeInput
from common import NodeOutput
from common import Params
from util.gcs_wrapper import GCS


def execute(gcs: GCS, _: Params, urls: NodeInput) -> NodeOutput:
    """Executes the copy_web_to_gcs action.

    Args:
      gcs: The GCS client.
      _: Workflow parameters.
      urls: A NodeInput containing the path to a file with URLs.

    Returns:
      A NodeOutput object containing the paths to the downloaded files in GCS.
    """
    urls_content = gcs.load_text(urls[0][Key.FILE.value])
    if isinstance(urls_content, bytes):
        urls_content = urls_content.decode('utf-8')
    url_list = [u.strip() for u in urls_content.splitlines() if u.strip()]
    output_files = []

    for index, url in enumerate(url_list):
        logger.info('Processing %s', url)
        try:
            response = requests.get(url, stream=True, timeout=30)
            response.raise_for_status()
            file_bytes = response.content

            content_type = None
            with contextlib.suppress(PIL.UnidentifiedImageError):
                with io.BytesIO(file_bytes) as input_stream:
                    img = PIL.Image.open(input_stream)
                    content_type = PIL.Image.MIME.get(img.format)

            if not content_type:
                content_type, _ = mimetypes.guess_type(url)

            if not content_type:
                content_type = response.headers.get('content-type')

            if not content_type:
                content_type = 'application/octet-stream'

            dot_extension = f'.{content_type.split("/")[-1]}'
            logger.debug('dot_extension %s', dot_extension)
            # Some URLs might have the same "filename" part, so we need to make
            # them unique by adding the index.
            raw_name = url.split('/')[-1].split('?')[0]
            logger.debug('raw_name %s', raw_name)
            if raw_name:
                base_file_name = f'{index}_{raw_name}'
            else:
                base_file_name = f'file_{index}'
            if not base_file_name.endswith(dot_extension):
                base_file_name += dot_extension
            logger.debug('base_file_name %s', base_file_name)

            gcs_path = gcs.store(file_bytes, base_file_name, content_type)
            output_files.append({Key.FILE.value: gcs_path})

        except requests.RequestException as e:
            logger.warning('Failed to process %s: %s', url, e)

    return {'file': output_files}
