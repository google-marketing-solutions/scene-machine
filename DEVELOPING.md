# Developers' Guide for Remix Engine and its applications

This repository currently comes with a single user interface, Scene Machine, which is designed to accelerate manual work on individual videos. The backend, Remix Engine, is also able to process other media, and scaled workloads. To avoid reinventing the wheel, new use cases could be added to this repository, either by "only" adding a new user interface, or by also adding functional modules should recombining the existing ones not suffice.

[Creating Applications](#creating-applications-on-remix-engine) •
[Applications Architecture](#applications-architecture) •
[RE Architecture](#remix-engine-architecture)

## Local dependencies

To install Python dependencies (incl. formatter):

- `pip-compile --generate-hashes --no-emit-index-url --output-file=requirements-dev.txt requirements-dev.in`
- `pip install -r requirements-dev.txt --upgrade`

## Creating Applications

In the absence of a generic user interface to define workflows, each actual tool built on Remix Engine can be limited to having a fixed workflow plus a user interface that

- allows the selection of inputs,
- allows the definition of all parameters,
- uploads the inputs to GCS and
- submits the workflow definition to the backend.

It could also

- expose intermediate results and
- allow to modify them.

The workflow is triggered by a call to `/supplyNode`, POSTing a JSON string as described in [Workflow Definition](#workflow-definition). This returns a JSON object with a property `executionId`, which can then be used to query the status of the execution via `/getStatus/[executionId]`.

## Modules not used by Scene Machine

As Remix Engine is meant for use by various applications and can also be useful when called on the command line, without any UI, the repository contains action modules that are not referenced by the user interface.

The following are awaiting inclusion in Scene Machine:

- `analyse_file.py`
- `convert_image.py`
- `convert_video.py`
- `copy_web_to_gcs.py`

The following serve a potential scaled workflow (like `scaled_video.json`) to generate ad videos from scratch:

- `devise_variants.py`
- `generate_arrangement.py`
- `generate_image.py`
- `write_ad_script.py`

The following are used by `demo.json` to test Remix Engine without any complex operations, e.g. for race conditions dealing with Firestore:

- `concat.py`
- `group_concat.py`
- `translate.py`

The following are obsolete:

- `write_products_script.py` (formerly used to generate storyboards based on image descriptions)

## When to use Remix Engine

The architecture could be used to realise all kinds of workflows:

- Existing workflows can be easily extended.
- Scaling across various data dimensions is built in.
  - New functionality can be added without worrying too much about that aspect.
  - Failures for part of the variants don't let the whole workflow fail.

But it is less suitable for use cases with the following properties:

- The core functionality cannot be reduced to transformations of input on GCS to output on GCS.
- All of the needed functionality requires additional modules.
- Steps of manual intervention cannot be realised in an HTML UI that uploads and shows GCS content.

## Known Issues

### Module `combine_video`

- The output video's frame rate is simply the highest of the inputs.
- Audio is added in a way that largely preserves (adds) input volumes and avoids clipping, but that may not satisfy professional requirements.

### Module `convert_image`

- The modules only considers extensions, not actual content, so there may be cases in which the source is left untouched although it is in a format actually incomprehensible for the downstream processors.

### Module `convert_video`

- Like `convert_image`, this only considers extensions rather than actual codecs.

### Module `outpaint_image`

- When an image has a frame, by its very nature, outpainting won't extend the inner image (well).

## Applications Architecture

TO DO

## Remix Engine Architecture

Remix Engine is a Cloud Run app in Python serving `/supplyNode`, which initially gets a configuration JSON to process the workflow's root node, and ultimately causes calls to itself to execute successor nodes.

Each node represents an `action`, and they are executed in parallel, using Cloud Tasks, on packets of input data. Those packets result from splitting the whole input in a way fitting the signature of the function to be executed and considering the structure of the input data – see [Input Format](#input-format).

Each packet is processed by a call to another route, `/triggerAction`, which after execution of the action informs the successor node(s) of its results. This is another call to `/supplyNode`, each of which gets aborted until all the needed input is available: the incoming data gets collected in Firestore – see [Firestore Status](#firestore-status) – until the call that sees the input completed proceeds with the actual execution via /triggerAction:

- `/supplyNode`:
  - prepare input
  - if input complete return 200 after queueing task (else 202 and finish):
    - for all input groups
      - call `/triggerAction`
        - return 200 after queueing task:
          - (actual work)
          - for all successors
            - prepare output
            - call `/supplyNode`

> **Note**: If, say, a translation node follows a transcription node, and the input is a list of recordings, the translation could theoretically start on some transcriptions while others are not yet ready. However, to limit complexity, the workflow only proceeds once all predecessor nodes are finished.

> **Note**: "Resource Exhausted" errors in actions are 'bubbled up' until `orch.py` returns HTTP code 429 so that Cloud Tasks retries them. Others (or the former after a certain number of failed retries) are logged but don't as such break the workflow. Of course, downstream nodes can themselves error out if their input is unavailable, which can ultimately be as useless as if the workflow had been stopped at the original error. Also, some 'meta' errors may lead to the error not even being propagated in the first place.

### Actions

Actions are defined in `actions.json` and implemented in the `actions` package in a file named after the action whose main function is called `execute`.

#### Actions Definition

`actions.json` describes what is available and how it operates, mainly the needed inputs and resulting outputs. The keys are the action names, and the values are dictionaries with the following properties:

- `input` and `output` are dictionaries describing the action's argument names and output properties, respectively. Besides naming them, types are provided to allow for compatibility checks and correct encoding/decoding. Optionally, `multi` indicates whether multiple inputs and outputs of this kind are possible, and `dimensions` lists the properties that the action will expect or add – see [Input Format](#input-format)]. Capturing this information 'redundantly' to the actual implementation increases transparency for workflow developers and allows for some automated tests.
- `parameters` is a dictionary listing the argument names to be hard-coded in the workflow definition, along with their types.

The file is accessible to both the UI and the backend.

<details>
<summary>Example</summary>
```javascript
{
    "greet": {
        "input": [{"name": "text", "type": "string"}],
        "parameters": {"salute": {"type": "string"}},
        "output": [{"name": "text", "type": "string"}]
    },
    "concat": {
        "input": [{"name": "text1", "type": "string"}, {"name": "text2", "type": "string"}],
        "output": [{"name": "text", "type": "string"}]
    },
    "group_concat": {
        "input": [{"name": "text", "type": "string", "multi": true}],
        "parameters": {"sorting_key": {"type": "string"}},
        "output": [{"name": "text", "type": "string"}]
    },
    "translate": {
        "input": [{"name": "text", "type": "string"}],
        "parameters": {"source_language": {"type": "string"}, "target_language": {"type": "string"}},
        "output": [{"name": "text", "type": "string", "multi": true, "dimensions": ["language"}]
    }
}
```
</details>

To check whether `actions.json` and the actions' implementation match, you can use this command: `python3 -m test.test_actions_sig`

#### Actions Implementation

The implementation of the actions needs to stick to the following rules, in addition to all names having to match the abstract definition:

- The action function's data arguments are GCS references as described above: dictionaries whose property `value` is an array of GCS URLs, but may have other properties – see [Input Format](#input-format)].
- In addition, there are parameter arguments that are arbitrary dictionaries.
- The return value is a dictionary of GCS references.

### Workflow Definition

Workflows are mainly defined as a set of nodes, each referencing the following information:

- `action` is the name of the action to execute, equalling the name of the function in the code.
- `input` is a dictionary whose keys denote the names of the input arguments of the function and whose values point to the node from which that input is to be sourced, that nodes's action's specific output to be used.
- `parameters` are optional and similar to inputs, the difference being that their values are hard-coded, i.e. would be specified manually in the UI rather than flowing in from an upstream node. Parameters that are arrays will result in the node being executed multiple times for each input: at least once for each element of the array, more often in case other parameters are also arrays.
- `dimensionsConsumed` are also optional, an array of strings identifying the input-data dimensions the node will ignore/flatten/consume – see [Input Grouping](#input-grouping).
- `dimensionsMapping` maps the dimensions that the action operates on (see [Actions Definition](#actions-definition)) to those actually to be used in the given workflow. For example, on the input side, an action might expect a "product_id" to align input texts and input images, where the upstream nodes actually provide a "prod_id". In output, several actions may add a "variant_id" that may require renaming to not cause unintended alignment. Both would be captured by `"dimensionsMapping": {"product_id": "prod_id", "variant_id": "variant_a_id"}}`. The target names of the mapping must be unique.

> **Note**: The action may or may not store the parameter(s) as dimensions in the output. For example, if the action is a translation, then the language parameter will usually be an output dimension that allows alignment by language. As another example, in creative content generation, one may use several "temperature" values to get several variants, and here the developer of the action would usually not have added that as a dimension, leading to a list of outputs that would be provided to downstream nodes.

The workflow definition is accompanied by some additional properties:

- `nodeId` initially denotes the root node to execute, but will vary in downstream executions.
- `workflowId` can be a checksum of the workflow definition and input, serving to store data under a recognisable name and preventing accidental re-execution of the same workflow.
- `inputFiles` is a dictionary whose keys are the names of the node's function's arguments, and whose values are arrays of dictionaries whose main content are file paths on GCS, pointing to the actual input data. Those inner dictionaries may have other properties – see [Input Grouping](#input-grouping) for their purpose.
- `workflowParams` is a dictionary defining workflow-level parameters like a project name or developer token.
- `forceExecution` is a boolean flag allowing the execution of the workflow without relying on results cached in previous runs.

Workflow definitions need to satisfy some 'natural' conditions:

- Node names must be distinct.
- Referenced actions must actually be implemented.
- Inputs and parameters of those actions must fit what they expect. (However, some inputs may be optional.)
- There may be no loops in the flow.

<details>
<summary>Example</summary>
The code comes with examples, [one of which](examples/example1.json) is explained below:

- inputs two texts and
- in separate workflow paths prepends both with two different greetings (at which point there are four texts),
- fake-translates those into two languages (making it eight) and
- concatenates the pairs with distinct greetings (making it four again).
- The paths then merge by concatenating each language's two texts into a long one,
- ultimately outputting two texts, one per language.

```javascript
{
    "workflowDefinition": {
      "root": {
        "action": "pass",
        "input": { "text": null }
    },
      "greet_0": {
        "action": "greet",
        "parameters": { "salute": "Hello" },
        "input": { "text": { "node": "root", "output": "text" } }
    },
      "greet_1": {
        "action": "greet",
        "parameters": { "salute": "Hi" },
        "input": { "text": { "node": "root", "output": "text" } }
    },
      "translate_0": {
        "action": "translate",
        "parameters": { "source_language": "en", "target_language": ["de", "fr"] },
        "input": { "text": { "node": "greet_0", "output": "text" } }
    },
      "translate_1": {
        "action": "translate",
        "parameters": { "source_language": "en", "target_language": ["de", "fr"] },
        "input": { "text": { "node": "greet_1", "output": "text" } }
    },
      "concat_0": {
        "action": "concat",
        "input": {
            "text1": { "node": "translate_0", "output": "text" },
            "text2": { "node": "translate_1", "output": "text" }
          }
      },
      "concat_group_0": {
        "action": "group_concat",
        "parameters": { "sorting_key": "id" },
        "dimensionsConsumed": ["id"],
        "input": { "text": { "node": "concat_0", "output": "text" } }
    },
      "sink": {
        "action": "pass",
        "input": {
            "concat_group_0.text": { "node": "concat_group_0", "output": "text" }
          }
      }
    },
    "nodeId": "root",
    "workflowId": "563456251290359025",
    "inputFiles": { "text": [
      {"file": "remix-input/OldWorld.txt", "id": "1"},
      {"file": "remix-input/NewWorld.txt", "id": "2"}] }
  }
```

</details>

### Input Format

The input data – and that forwarded between nodes – is a dictionary of annotated GCS references, each property representing a type of input to the work function, with the key naming the function argument. The arrays themselves – for simplicity, they are such even if only one element is present – consist of dictionaries that at least contain a key `file` with the actual path on GCS.

> **Note**: The difference between input and output of the action functions is that the input is split into the named named arguments, whereas the output is a single dictionary keyed by output name.

#### Dimensions

The input dictionaries can also have other properties, called "dimensions", which by convention are all strings to allow unambiguous comparisons between values. They can be used by the actions to process the input in a suitable way, but are mostly used to determine which input files belong together, ultimately grouping the input for each execution – see [Input Grouping](#input-grouping).

> **Note**: To ensure that set of inputs are processed separately, they all should have at least one distinct dimension value. For example, if we have three images for two products each that are to be turned into videos and then combined into one video per product, we need some "product_id" dimension to allow for the right groups to be combined, but also what could be called "input_id" (that differs among a product's images), so that the images get individually channeled to the video-creation action.

> **Note**: In the code, there is an ENUM `Dimension` to be used where actions read and write dimensions, so that their spelling can be better checked for identity with those mentioned in actions.json. Across actions, they don't need to align, but it makes sense to keep this simply so that, in the best case, workflow designers don't need to rename dimensions to get actions to collaborate. They also don't need to align with the representation of the corresponding entities inside the action implementation: For example, some actions may input and/or output an `image_id` dimension and also have "image_id" as a key in some intermediate object. The code avoids using the ENUM `Dimension` in those other cases to clarify that this is not the dimension name used as such, and that the name could be different.

<details>
<summary>Example</summary>
As an example, let's assume we have an action with the following inputs to build an ad:

- `celebrityName` is an audience-specific celebrity to feature in the ad.
- `text` is the main language- and country-specific text
- `image` are a audience-specific images that we don't have for all audiences
- `legalese` is a country-specific legal text that has to be in the ad
- `experiments` is a text with campaign settings of which we have two variants to compare their performance

Input for this – either input manually when defining the workflow, or flowing from upstream nodes – could look as follows:

```javascript
{
    'celebrityName': [{'file': 'X.txt', 'audience': 'a'},
                      {'file': 'Y.txt', 'audience': 'b'},
                      {'file': 'Z.txt', 'audience': 'c'}],
    'text': [{'file': 'G.txt', 'language': 'de', 'country': 'DE'},
             {'file': 'H.txt', 'language': 'fr', 'country': 'CH'},
             {'file': 'I.txt', 'language': 'de', 'country': 'CH'},
             {'file': 'J.txt', 'language': 'en', 'country': 'GB'}],
    'image': [{'file': 'I1.png', 'audience': 'a'},
              {'file': 'I2.png', 'audience': 'a'}],
    'legalese': [{'file': 'DE.txt', 'country': 'DE'},
                 {'file': 'CH.txt', 'country': 'CH'},
                 {'file': 'IT.txt', 'country': 'IT'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'},
                    {'file': 'E2.txt', 'option': '2'}]
}
```

</details>

### Input Grouping

Workflows can be used to process data that is independent from each other, either because it was initially supplied (e.g. a list of videos to be processed identically) or because of in-workflow multiplication (e.g. translations into multiple languages). Hence, whenever a node is given input, it needs to be determined how to split that input into workloads for separate executions. This is done using the non-`file` properties of the inner dictionaries of inputs, "[Dimensions](#dimensions)".

<details>
<summary>Example</summary>
For the previous example, 30 grouped inputs result, 15 of which are shown here – the other half has `option` 2 for the experiment:

```javascript
[{
    'celebrityName': [{'file': 'X.txt', 'audience': 'a'}],
    'text': [{'file': 'G.txt', 'language': 'de', 'country': 'DE'}],
    'image': [{'file': 'I1.png', 'audience': 'a'},
              {'file': 'I2.png', 'audience': 'a'}],
    'legalese': [{'file': 'DE.txt', 'country': 'DE'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'X.txt', 'audience': 'a'}],
    'text': [{'file': 'H.txt', 'language': 'fr', 'country': 'CH'}],
    'image': [{'file': 'I1.png', 'audience': 'a'},
              {'file': 'I2.png', 'audience': 'a'}],
    'legalese': [{'file': 'CH.txt', 'country': 'CH'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'X.txt', 'audience': 'a'}],
    'text': [{'file': 'I.txt', 'language': 'de', 'country': 'CH'}],
    'image': [{'file': 'I1.png', 'audience': 'a'},
              {'file': 'I2.png', 'audience': 'a'}],
    'legalese': [{'file': 'CH.txt', 'country': 'CH'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'X.txt', 'audience': 'a'}],
    'text': [{'file': 'J.txt', 'language': 'en', 'country': 'GB'}],
    'image': [{'file': 'I1.png', 'audience': 'a'},
              {'file': 'I2.png', 'audience': 'a'}],
    'legalese': [],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'X.txt', 'audience': 'a'}],
    'text': [],
    'image': [{'file': 'I1.png', 'audience': 'a'},
              {'file': 'I2.png', 'audience': 'a'}],
    'legalese': [{'file': 'IT.txt', 'country': 'IT'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'X.txt', 'audience': 'b'}],
    'text': [{'file': 'G.txt', 'language': 'de', 'country': 'DE'}],
    'image': [],
    'legalese': [{'file': 'DE.txt', 'country': 'DE'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'X.txt', 'audience': 'b'}],
    'text': [{'file': 'H.txt', 'language': 'fr', 'country': 'CH'}],
    'image': [],
    'legalese': [{'file': 'CH.txt', 'country': 'CH'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'X.txt', 'audience': 'b'}],
    'text': [{'file': 'I.txt', 'language': 'de', 'country': 'CH'}],
    'image': [],
    'legalese': [{'file': 'CH.txt', 'country': 'CH'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'X.txt', 'audience': 'b'}],
    'text': [{'file': 'J.txt', 'language': 'en', 'country': 'GB'}],
    'image': [],
    'legalese': [],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'X.txt', 'audience': 'b'}],
    'text': [],
    'image': [],
    'legalese': [{'file': 'IT.txt', 'country': 'IT'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'Z.txt', 'audience': 'c'}],
    'text': [{'file': 'G.txt', 'language': 'de', 'country': 'DE'}],
    'image': [],
    'legalese': [{'file': 'DE.txt', 'country': 'DE'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'Z.txt', 'audience': 'c'}],
    'text': [{'file': 'H.txt', 'language': 'fr', 'country': 'CH'}],
    'image': [],
    'legalese': [{'file': 'CH.txt', 'country': 'CH'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'Z.txt', 'audience': 'c'}],
    'text': [{'file': 'I.txt', 'language': 'de', 'country': 'CH'}],
    'image': [],
    'legalese': [{'file': 'CH.txt', 'country': 'CH'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'Z.txt', 'audience': 'c'}],
    'text': [{'file': 'J.txt', 'language': 'en', 'country': 'GB'}],
    'image': [],
    'legalese': [],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'Z.txt', 'audience': 'c'}],
    'text': [],
    'image': [],
    'legalese': [{'file': 'IT.txt', 'country': 'IT'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},...]
```

</details>

Only non-contradictory data is passed to functions, but the absence of a match is considered okay, as the empty arrays in the example show. It is up to the action to discard inputs it cannot work with, as it can be perfectly normal for some action to not be able to produce certain input and for this then to prevent certain recombinations from being considered downstream. Importantly, the action _must_ still return an empty result in these cases so that the downstream nodes don't eternally wait for it.

#### Dimension 'consumption'

Nodes can be defined as 'consuming' a dimension, if in their case the input should not be split by that. For example, suppose we have a list of scene transcripts with dimension "sceneId": while it makes sense to turn them to speech separately, a downstream node combining those audio snippets sequentially would need to access all of them at once.

#### Dimension addition

As mentioned, data can have dimensions from the initial definition in the UI or due to nodes adding them. For example, a translation node can turn each input text into several output texts, each annotated with their language.

It can also be that a 'consumed' dimension gets added again. One example for this is a node that writes a single story inspired by several input photos of people that may have a "person_id", but also outputs a characterisation for each of these people, which feature their "person_id".

#### Dimension renaming

The `dimensionsMapping` mentioned in [Workflow Definition](#workflow-definition) is applied just before the input grouping to ensure the dimension names match those expected by the action. (With the converse mapping happening after execution.)

### Output–Input Mapping

When a node is done, its output gets mapped to the input of its successors by potentially renaming the dictionary keys.

For example, in the workflow defined previously, we have node `concat_0` with:

```
    "input": {
        "text1": { "node": "translate_0", "output": "text" },
        "text2": { "node": "translate_1", "output": "text" }
    }
```

The outputs of the translation nodes hence need to be renamed from `text` to `text1` and `text2`, respectively before being passed to `concat_0`.

### Firestore Status

As mentioned, nodes only proceed once they have all their input. As that gets provided by independently executed requests, there needs to be a place where this input gets collected and that allows a determination of its completeness. For this, each workflow execution entails the creation of a Firestore collection containing one document per node in the workflow. These documents have the following fields:

- `inputFiles` contains the merged value of all separately provided inputs
- `targetCounts` is a dictionary whose keys are the keys of the `inputFiles` and whose values specify from how many different source executions data will need to be collected.
- `actualCounts` is a similar dictionary, listing how many sources already have contributed to the respective input argument.
- `lastUpdated` is a timestamp for debugging purposes.

Already the first source reporting data knows how many sibling sources it has and which input arguments exist in total, so whenever new data comes in, it can be checked if all these arguments are accounted for with all their respective sources.

### Cloud Storage for storing/caching action output

It is conceivable that workflows will most often be modified in some downstream node to refine the ultimate output. In such a case, it is unnecessary to execute all the upstream actions again, hence Cloud Storage is used to automatically cache results information: Prior to each execution, the existence of a certain file is checked whose name is determined by the action name and a checksum of inputs and parameters. If it does, its contents are used in the action output's stead.

If not, the action gets executed and its output stored in said file. For this, the action is handed an object that allows

- access to the files on Cloud Storage that the input data points to, as well as
- the easy storage of data with a filename of its choice, as name collisions are avoided because the storage automatically and transparently happens in a designated folder that is unique to the action and its input data and parameters (via a checksum).

## Testing

The folder `workflow_examples` contains numerous JSON files that can be used to check if the tool works. They rely on files that get uploaded to the configured GCS bucket as part of the deployment process. There are two ways of executing the examples:

### Running workflows with endpoint calls

It is possible to call a workflow `demo.json` without relying on the user interface. To do that, we first need to determine the URL to call:

```
source config.txt
export CLOUD_RUN_URL=$(gcloud run services describe orch --region=$REGION --project=$PROJECT --format='value(status.url)')
```

Then we can call the actual workflow, here `demo.json`, while substituting some of the values defined in `config.txt`:

```
curl -X POST $CLOUD_RUN_URL/supplyNode -H "Authorization: bearer $(gcloud auth print-identity-token)" -H "Content-Type: application/json" -d @<(envsubst < workflow_examples/demo.json)
```

Among the first lines of the (quite verbose) textual output, you will find an execution ID that can be used to check the execution status, either by entering it on the `/status` page of Scene Machine mentioned [here](README.md#technical-problems), or with the following command, albeit with a complex output:

```
curl -H "Authorization: bearer $(gcloud auth print-identity-token)" -X GET $CLOUD_RUN_URL/getStatus?executionId=<EXECUTION ID>
```

### Running workflows with CLI calls

It is also possible to achieve the same as above, but without relying on Cloud Run or Cloud Tasks. The following simply runs the Python code locally:

```
source config.txt
python3 cli.py --e <(envsubst < workflow_examples/image2video.json)
python3 cli.py --bucket remix-engine-bucket --s <EXECUTION ID>
```

### Other means of testing

There are various unit tests in the folders `test`, `actions/test` and `actions_lib/test`.

In addition, the following calls are available:

- `python3 -m test.test_actions_sig`: This compares the signatures of the modules in the `actions` folder with those defined in `actions.json`.
- `python3 -m test.simulate_workflow`: This conducts a mock run of a workflow (you'd need to change the hard-coded one in the file) to check how the data would flow, especially in terms of the "dimensions" attached.
