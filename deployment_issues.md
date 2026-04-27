# Issues found with deployment
- the README instructions are out of date wrt. what it asks for
- the deploy.sh has a problem with quotes around the project name. It should be fine.
- need to have the Firebase CLI installed
- crashed with Firebase project not found
  - waiting doesn't help
- if Firebase fails, the user may need to go and accept the firebase terms of service (note from vsp@)
- need to run `firebase login` before creating Firebase things.
  - need to find out how that works
  - might need to add firebase to the cloud project
- *MANUALLY CREATED THE FIREBASE PROJECT IN THE CONSOLE*
  - [] find the correct instructions to create a firebase project with the cli
- Firebase directions for setting up storage are out of date
  1. select the project you created from the list on the right
  2. hover over "Databases & Storage" on the left of the project page.
  3. Select "Storage" under the "Object Storage" header.
  4. ensure the location selected is the same as you selected for the project
    - no-cost locations are only available in the USA.
  5. start in production mode to ensure the data in firebase is kept private.
- The place to add buckets is in the drop-down with the project name in is (add a screenshot)
- the note on adding buckets should note that there will be other buckets
- when importing the bucket, there is a warning that the bucket doesn't allow read or write
  - continue, and update the rules on the next screen
  - the description of the change needed must be more clear. Provide complete example of the rule block
- why are we jumping to the firebase console and back? Can auth be set up at the same time as the buckets?
- add a step to set up the OAuth consent screen to the README before running deploy-ui.
- add a step for enabling Firebase Google sign-in provider before running deploy-ui.
  - needs actual instructions on where to find things.
  - from the project overview, choose Security > Authentication from the list on the left.
  - Choose "Sign-in method" from the tabs at the top
  - Choose Google from the list of Additional Providers.
  - Click the "Enable" toggle in at the top-right of the box.
  - click save
  - seems like this is step 9, but there's no option to set
- Step 9 - select the settings tab from the top
  - select Authorized Domains in the box
  - *This was already done for me*
- in step 10, specify whether the credentials need to be downloaded.
