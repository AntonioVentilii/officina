# Changelog

## [1.12.0](https://github.com/AntonioVentilii/officina/compare/v1.11.1...v1.12.0) (2026-11-19)


### Features

* **core,api:** show the reviewers' findings in show_task and task show ([#273](https://github.com/AntonioVentilii/officina/issues/273)) ([cb3b314](https://github.com/AntonioVentilii/officina/commit/cb3b31452dcb95a52a7e61a22daacae418d80ad4))
* **core,db,api,board:** allow one task a larger change than its lane's size limit ([#272](https://github.com/AntonioVentilii/officina/issues/272)) ([caf1b8f](https://github.com/AntonioVentilii/officina/commit/caf1b8f13a458605556c5831407181c93b63ab3a))

## [1.11.1](https://github.com/AntonioVentilii/officina/compare/v1.11.0...v1.11.1) (2026-11-17)


### Bug Fixes

* **api,board:** make the proposal notice readable and name the button that confirms it ([#270](https://github.com/AntonioVentilii/officina/issues/270)) ([58d06d4](https://github.com/AntonioVentilii/officina/commit/58d06d401e6c2858ad8be75c88f14d58357ae096))

## [1.11.0](https://github.com/AntonioVentilii/officina/compare/v1.10.0...v1.11.0) (2026-11-17)


### Features

* **api,board:** name the connection of the app that proposed an approval ([#268](https://github.com/AntonioVentilii/officina/issues/268)) ([597708b](https://github.com/AntonioVentilii/officina/commit/597708b118ba330d44d43f4f0ab43fa55931321f))

## [1.10.0](https://github.com/AntonioVentilii/officina/compare/v1.9.0...v1.10.0) (2026-11-17)


### Features

* **api,board:** hand a claimed build back from the board and the cli ([#264](https://github.com/AntonioVentilii/officina/issues/264)) ([83346bc](https://github.com/AntonioVentilii/officina/commit/83346bcabc69b75d4db20f55e1d906ccf2adc53a))
* **api,board:** tell same-named connected apps apart by their connection ([#265](https://github.com/AntonioVentilii/officina/issues/265)) ([a7c98f6](https://github.com/AntonioVentilii/officina/commit/a7c98f650d7e612a4779b6baeaf382eb1abcc2ad))
* **api:** show_task names the project's pull request template to whoever may build ([#262](https://github.com/AntonioVentilii/officina/issues/262)) ([38b9f72](https://github.com/AntonioVentilii/officina/commit/38b9f7253682023a6787e4ec51830e205bb99b3c))
* **api:** task show lists each checklist item with its latest check ([#261](https://github.com/AntonioVentilii/officina/issues/261)) ([89510a5](https://github.com/AntonioVentilii/officina/commit/89510a5a0a01c82033e1a625feadcef3357d65ae))
* **core,api,board:** an approval from chat is a proposal the member confirms on the board ([#266](https://github.com/AntonioVentilii/officina/issues/266)) ([6ef058f](https://github.com/AntonioVentilii/officina/commit/6ef058f597929809ea5da7d1ec9955fd44a24906))


### Bug Fixes

* **api,board:** say a result's check was skipped when it was auto-verified ([#267](https://github.com/AntonioVentilii/officina/issues/267)) ([9591f7b](https://github.com/AntonioVentilii/officina/commit/9591f7b15c082d89b87d827096a046912551fbb8))

## [1.9.0](https://github.com/AntonioVentilii/officina/compare/v1.8.0...v1.9.0) (2026-11-17)


### Features

* **core,db,engine,github,api,board:** record each checklist check with its evidence, shown on the pull request ([#258](https://github.com/AntonioVentilii/officina/issues/258)) ([41d0c62](https://github.com/AntonioVentilii/officina/commit/41d0c62a22e38b6f97d770c27b49e5034c9adfa5))


### Bug Fixes

* **api,board:** show a passed gate's approvers as they were when it passed ([#259](https://github.com/AntonioVentilii/officina/issues/259)) ([e245327](https://github.com/AntonioVentilii/officina/commit/e245327c03af8e017c6ec661aeec1f75f301ac7f))


### Miscellaneous Chores

* **deps-dev:** bump @sveltejs/kit from 2.70.4 to 3.2.0 in /apps/board in the npm_and_yarn group across 1 directory ([#256](https://github.com/AntonioVentilii/officina/issues/256)) ([3a72b98](https://github.com/AntonioVentilii/officina/commit/3a72b988f984befdc39fec65d4409e5378c92d42))

## [1.8.0](https://github.com/AntonioVentilii/officina/compare/v1.7.7...v1.8.0) (2026-11-17)


### Features

* **api,board:** record which connected app acted for a member and show it in the timeline ([#232](https://github.com/AntonioVentilii/officina/issues/232)) ([80fca18](https://github.com/AntonioVentilii/officina/commit/80fca18a1604d9ac90a15f5921e8fa54138ea76b))
* **api:** claim and hand back a build from the claude connector ([#231](https://github.com/AntonioVentilii/officina/issues/231)) ([9f8e48e](https://github.com/AntonioVentilii/officina/commit/9f8e48e3aba1be131240c2f58cf677ec9b21272f))
* **core,engine,api,board:** pull requests follow the project's pull request template ([#249](https://github.com/AntonioVentilii/officina/issues/249)) ([5113141](https://github.com/AntonioVentilii/officina/commit/51131419b50c17f9352c4399b87fd27a3b1d1b64))


### Bug Fixes

* **api:** tell the requester a guarded request waits for an owner ([#237](https://github.com/AntonioVentilii/officina/issues/237)) ([7c70c02](https://github.com/AntonioVentilii/officina/commit/7c70c02c7f6157e8876a0b112045a4f5fd23e862))
* **board:** let only the latest task drawer load land ([#247](https://github.com/AntonioVentilii/officina/issues/247)) ([0887387](https://github.com/AntonioVentilii/officina/commit/08873873d22fb768b51d18e79712f8dae33f32b7))
* **board:** mark the current page in the sidebar for screen readers ([#251](https://github.com/AntonioVentilii/officina/issues/251)) ([6290bef](https://github.com/AntonioVentilii/officina/commit/6290bef90f1d48d9dd60622bae25bbc6a0647dbf))
* **board:** show a failed board load on every page ([#250](https://github.com/AntonioVentilii/officina/issues/250)) ([5b0094e](https://github.com/AntonioVentilii/officina/commit/5b0094e6e66b6a17a159446002c7ff9f3a32e763))
* **board:** stop counting done tasks as open ([#243](https://github.com/AntonioVentilii/officina/issues/243)) ([bb56274](https://github.com/AntonioVentilii/officina/commit/bb562740883859dc436cb5e67ef51112dc0d406d))
* **core,api:** offer to send a request on as it is only when it may be ([#234](https://github.com/AntonioVentilii/officina/issues/234)) ([84a0433](https://github.com/AntonioVentilii/officina/commit/84a04335c35ddf5c6a40655a27f2092adc55c0f0))
* **core:** say only what steering lets a maintainer do today ([#241](https://github.com/AntonioVentilii/officina/issues/241)) ([4392747](https://github.com/AntonioVentilii/officina/commit/4392747cf7d84f2b412af4631606715f497556c0))


### Documentation

* **ai:** list the board's other hand-mirrored values in patterns.md ([#246](https://github.com/AntonioVentilii/officina/issues/246)) ([76cf69b](https://github.com/AntonioVentilii/officina/commit/76cf69b9b837b87d574677d7230f9e0b84df7919))
* **ai:** name each-task.ts in the structure row for running a step ([#244](https://github.com/AntonioVentilii/officina/issues/244)) ([46c5ed0](https://github.com/AntonioVentilii/officina/commit/46c5ed02252344c1c863f5dbb6d143ee3dd0da60))
* **repo:** add fix_rounds and runtime.allowed_hosts to the example project config ([#239](https://github.com/AntonioVentilii/officina/issues/239)) ([571fd24](https://github.com/AntonioVentilii/officina/commit/571fd24afbc4c7bdccbb0d76bc880ea7973c68dc))
* **repo:** move unbuilt triage, thread, spec and board features to the planned list ([#236](https://github.com/AntonioVentilii/officina/issues/236)) ([d093379](https://github.com/AntonioVentilii/officina/commit/d0933796c169e63db1fd202bcb0e439f5bb8e2cb))
* **repo:** rewrite the roadmap phases and status from the code ([#242](https://github.com/AntonioVentilii/officina/issues/242)) ([4c424a5](https://github.com/AntonioVentilii/officina/commit/4c424a5dcacf76c8ad6cf615ef78b232aba9afd7))


### Code Refactoring

* **core,engine:** clip every error an event or a run records to one named length ([#252](https://github.com/AntonioVentilii/officina/issues/252)) ([85e5f72](https://github.com/AntonioVentilii/officina/commit/85e5f72fd550b7d6702c2ed22c1c9ffb0c59899e))
* **core:** keep the setup key accepted, marked as not used yet ([#255](https://github.com/AntonioVentilii/officina/issues/255)) ([3b617b3](https://github.com/AntonioVentilii/officina/commit/3b617b3b43a202707e5767d6a4f2b8915535fe32))
* **core:** move newTask to the core test fixtures ([#253](https://github.com/AntonioVentilii/officina/issues/253)) ([730560a](https://github.com/AntonioVentilii/officina/commit/730560adb5a343dfcf2d8ebcb91fa4f08560fd18))
* **db,engine:** read the learner's timeline events through core's typed domain events ([#248](https://github.com/AntonioVentilii/officina/issues/248)) ([b6ea462](https://github.com/AntonioVentilii/officina/commit/b6ea462e79ab3c20e4e442e602fa2f02c0ef4cf6))
* **runner,engine:** one guard for a runner role, beside RUNNER_ROLES ([#254](https://github.com/AntonioVentilii/officina/issues/254)) ([ca9d57d](https://github.com/AntonioVentilii/officina/commit/ca9d57d346a440306e4edf261d69206e2c02dfdb))


### Tests

* **api:** decide the held scheduler pass tests by a condition, not a sleep ([#235](https://github.com/AntonioVentilii/officina/issues/235)) ([2b99700](https://github.com/AntonioVentilii/officina/commit/2b997006b2780b422a0ffad555b7ec8e9080388d))
* **core:** cover the lifecycle refusals no test exercised ([#233](https://github.com/AntonioVentilii/officina/issues/233)) ([b9bc5e7](https://github.com/AntonioVentilii/officina/commit/b9bc5e7b9af5ad0ee502883c88dad5f50f237cce))
* **engine:** age a bot comment past the settle window by its constant ([#238](https://github.com/AntonioVentilii/officina/issues/238)) ([7dad1a1](https://github.com/AntonioVentilii/officina/commit/7dad1a147eb2e15402a12dbb6a6225cc3c21b262))
* **runner:** drive the SDK port through a real client on a fake fetch, not a cast ([#240](https://github.com/AntonioVentilii/officina/issues/240)) ([893b77e](https://github.com/AntonioVentilii/officina/commit/893b77eb82fccff646b7b6f3bd4adfb1962fc438))

## [1.7.7](https://github.com/AntonioVentilii/officina/compare/v1.7.6...v1.7.7) (2026-11-16)


### Bug Fixes

* **api,board:** mark each person's approval, not every member with the approver's name ([#230](https://github.com/AntonioVentilii/officina/issues/230)) ([32a24b1](https://github.com/AntonioVentilii/officina/commit/32a24b1f2a76c4dca938719a8c032a3f5f7ceb67))
* **board:** key people, verifiers and before/after rows by position, not by text ([#228](https://github.com/AntonioVentilii/officina/issues/228)) ([1bbced7](https://github.com/AntonioVentilii/officina/commit/1bbced74f98bd81bde6720c386d841191a353d7c))

## [1.7.6](https://github.com/AntonioVentilii/officina/compare/v1.7.5...v1.7.6) (2026-11-16)


### Bug Fixes

* **api,board:** keep reading a run log past a page the log mostly drops ([#209](https://github.com/AntonioVentilii/officina/issues/209)) ([5addd77](https://github.com/AntonioVentilii/officina/commit/5addd77cec15958726b2f41d26d3da20b65e94e4))
* **board:** list every card the Inbox badge counts on the Inbox page ([#221](https://github.com/AntonioVentilii/officina/issues/221)) ([c157861](https://github.com/AntonioVentilii/officina/commit/c157861e8a901aeab30ebc5ec66c7f969c05dee8))
* **board:** make the task drawer a modal dialog that takes and gives back focus ([#225](https://github.com/AntonioVentilii/officina/issues/225)) ([976af47](https://github.com/AntonioVentilii/officina/commit/976af47f02787f8f8006199ad84c0109c1e8fa4b))
* **board:** refresh every view when the browser reconnects the change stream ([#212](https://github.com/AntonioVentilii/officina/issues/212)) ([6dd8f3a](https://github.com/AntonioVentilii/officina/commit/6dd8f3aa8dedad5b0f3aa28512ad789ff9bd1fcb))
* **core,api,board:** offer asking for changes only to the people the gate names ([#216](https://github.com/AntonioVentilii/officina/issues/216)) ([461b846](https://github.com/AntonioVentilii/officina/commit/461b8467e424439ce5de5e4f7e8a47fdd66cdb23))
* **core,board:** ask for each approval once at a gate, so a guarded task's panel opens ([#227](https://github.com/AntonioVentilii/officina/issues/227)) ([f0f0d1d](https://github.com/AntonioVentilii/officina/commit/f0f0d1d50ce7b620362e2045ef51ae0de8f388a7))
* **engine,api:** check each task on its own when taking in outside pushes and forwarding bot comments ([#210](https://github.com/AntonioVentilii/officina/issues/210)) ([79c24e7](https://github.com/AntonioVentilii/officina/commit/79c24e7fe1b9dc2de9ae6227a664e8056de46a13))
* **engine,db:** check pending bot comments on the locked transaction when turning auto-merge on ([#220](https://github.com/AntonioVentilii/officina/issues/220)) ([62f3538](https://github.com/AntonioVentilii/officina/commit/62f3538b597d9e38671393c8df60ed029ec3a2c1))
* **engine:** send a pushed or handed-in head back when its checks were already red ([#218](https://github.com/AntonioVentilii/officina/issues/218)) ([8af1d9e](https://github.com/AntonioVentilii/officina/commit/8af1d9eeef34de8f1477ba870d2abac011d47503))
* **engine:** take Officina's own lost status commit as the task's head at merging ([#211](https://github.com/AntonioVentilii/officina/issues/211)) ([0b0aefe](https://github.com/AntonioVentilii/officina/commit/0b0aefee4fa7e3ae537fb3a02854b4bd77eb6afb))
* **engine:** write the Implemented spec status safely when another writer set it first ([#214](https://github.com/AntonioVentilii/officina/issues/214)) ([bc63f08](https://github.com/AntonioVentilii/officina/commit/bc63f0869764cbcaa110d717c7982ec941f5b5fa))
* **github,api:** wait for a GitHub rate limit to reset before the next scheduler pass ([#224](https://github.com/AntonioVentilii/officina/issues/224)) ([5a2fac0](https://github.com/AntonioVentilii/officina/commit/5a2fac0bbace7bbac8511633bb64807fd0c8d887))


### Documentation

* **ai:** catalog the shared pieces that had no row ([#223](https://github.com/AntonioVentilii/officina/issues/223)) ([d9672b5](https://github.com/AntonioVentilii/officina/commit/d9672b592922e31a36b53111a0731feb91a9e029))
* **repo:** describe as current only what exists ([#208](https://github.com/AntonioVentilii/officina/issues/208)) ([cd8eac3](https://github.com/AntonioVentilii/officina/commit/cd8eac3fe37e552209e3ba57b95d50bbe6ffcfcc))


### Code Refactoring

* **api,board,core,db:** write each value once ([#215](https://github.com/AntonioVentilii/officina/issues/215)) ([baa0959](https://github.com/AntonioVentilii/officina/commit/baa09591fc07971c8da9320e385a3d1ffa13d022))
* **api:** name the connector's two unauthorized responses ([#219](https://github.com/AntonioVentilii/officina/issues/219)) ([acb3218](https://github.com/AntonioVentilii/officina/commit/acb3218a17418335cb22c7d574a08d07cac2f918))


### Tests

* **api,engine,github:** type fakes as their port instead of casting them ([#217](https://github.com/AntonioVentilii/officina/issues/217)) ([b839325](https://github.com/AntonioVentilii/officina/commit/b83932576fe0e88c7bcae872eff8bee692d63026))
* **api:** try every route that changes something without the request header ([#207](https://github.com/AntonioVentilii/officina/issues/207)) ([e41198a](https://github.com/AntonioVentilii/officina/commit/e41198abfde167d2e87caebc904b638994fe1ec1))
* **board:** cover the diff shown for a learning's edit ([#222](https://github.com/AntonioVentilii/officina/issues/222)) ([18edd36](https://github.com/AntonioVentilii/officina/commit/18edd36b0a8beb81dbe15804e32de38f8c74243b))
* **db,api,engine:** age rows from the named windows and wait on the lock holder ([#213](https://github.com/AntonioVentilii/officina/issues/213)) ([eecc8c9](https://github.com/AntonioVentilii/officina/commit/eecc8c92bcec2bd8c2d3611707ef0d053b44349f))

## [1.7.5](https://github.com/AntonioVentilii/officina/compare/v1.7.4...v1.7.5) (2026-11-16)


### Bug Fixes

* **api,db,board:** open a request sent again with the same id only once ([#191](https://github.com/AntonioVentilii/officina/issues/191)) ([6a49c04](https://github.com/AntonioVentilii/officina/commit/6a49c044c026d34010bbcba5c31145afc2aa7b80))
* **api,github:** forget a GitHub account whose refresh token GitHub refuses ([#199](https://github.com/AntonioVentilii/officina/issues/199)) ([638d7ae](https://github.com/AntonioVentilii/officina/commit/638d7ae5525a474a4905fbd91d882b9a6d6f5cd8))
* **api:** catch up missed pull request webhooks from building on ([#197](https://github.com/AntonioVentilii/officina/issues/197)) ([957604a](https://github.com/AntonioVentilii/officina/commit/957604a32ba0225ec4e008d8d39b775088407e58))
* **api:** forward a person's review only when they may write to the repository (GHSA-j598-pp47-p3jp) ([2696381](https://github.com/AntonioVentilii/officina/commit/2696381f1667ac1f0235620ae2573a12bcfc586a))
* **engine:** finish opening a pull request whose spec status write lost a race ([#195](https://github.com/AntonioVentilii/officina/issues/195)) ([adfb9d9](https://github.com/AntonioVentilii/officina/commit/adfb9d92aa9af62900ee7ce0d62a60acce4d2639))
* **engine:** stop live builds and revoke their tokens on shutdown (GHSA-59cq-rp5p-crvw) ([2696381](https://github.com/AntonioVentilii/officina/commit/2696381f1667ac1f0235620ae2573a12bcfc586a))
* **engine:** turn auto-merge on again after a hold for a bot comment ([#187](https://github.com/AntonioVentilii/officina/issues/187)) ([74f7601](https://github.com/AntonioVentilii/officina/commit/74f7601dc80743af3c93e3d0338dfa473990ab2f))
* **engine:** turn auto-merge on only while the task is still merging ([#185](https://github.com/AntonioVentilii/officina/issues/185)) ([3a9e278](https://github.com/AntonioVentilii/officina/commit/3a9e278d20b3ab537357ef881ccc475f1994e40c))
* **github:** count a check suite only when it ran on the task's own branch (GHSA-59fm-g28g-2w2w) ([2696381](https://github.com/AntonioVentilii/officina/commit/2696381f1667ac1f0235620ae2573a12bcfc586a))


### Documentation

* **ai:** list every shared piece missing from the reusability catalog ([#201](https://github.com/AntonioVentilii/officina/issues/201)) ([b371f6a](https://github.com/AntonioVentilii/officina/commit/b371f6a732fe034811e90196dca1f78b25aec5a6))
* **repo:** describe as current only what the code does ([#194](https://github.com/AntonioVentilii/officina/issues/194)) ([09a8b8e](https://github.com/AntonioVentilii/officina/commit/09a8b8e00158ea75f270f573db623174e9d5d795))
* **repo:** list the three advisories fixed in 1.7.5 ([2696381](https://github.com/AntonioVentilii/officina/commit/2696381f1667ac1f0235620ae2573a12bcfc586a))


### Code Refactoring

* **core,db,engine,api,board:** write each run, branch and truncation rule once ([#182](https://github.com/AntonioVentilii/officina/issues/182)) ([0f707a2](https://github.com/AntonioVentilii/officina/commit/0f707a272d7028673e244c1aa406120f8bf96dc6))


### Tests

* **api:** cover a hand-in refused for a missing App or an unreadable branch ([#198](https://github.com/AntonioVentilii/officina/issues/198)) ([d299846](https://github.com/AntonioVentilii/officina/commit/d299846b82172558047dbe6844e8813583b34f93))
* **board:** cover the Markdown sanitizer, with jsdom for tests only ([#204](https://github.com/AntonioVentilii/officina/issues/204)) ([217b0eb](https://github.com/AntonioVentilii/officina/commit/217b0eb0dbbff399ed99165e01f28207ac4bd21f))
* **db,engine:** wait for the lock in race tests instead of sleeping ([#193](https://github.com/AntonioVentilii/officina/issues/193)) ([92e598a](https://github.com/AntonioVentilii/officina/commit/92e598a4f576ae3b3ada9f6ffaa5c720e0a0e904))

## [1.7.4](https://github.com/AntonioVentilii/officina/compare/v1.7.3...v1.7.4) (2026-11-15)


### Bug Fixes

* **api,db:** decide a learning without a transaction held across its GitHub calls ([#176](https://github.com/AntonioVentilii/officina/issues/176)) ([597a88a](https://github.com/AntonioVentilii/officina/commit/597a88a1ac6e221a29626414fe496a78c5b6213f))
* **api:** back off while scheduler passes keep failing ([#177](https://github.com/AntonioVentilii/officina/issues/177)) ([2400061](https://github.com/AntonioVentilii/officina/commit/2400061823dca5a49a7b1e3d8e98c0ca1b5d7ab0))
* **api:** keep the pass going when one project throws ([#174](https://github.com/AntonioVentilii/officina/issues/174)) ([dbe7fe8](https://github.com/AntonioVentilii/officina/commit/dbe7fe879b45fb13a79893c5b6f3653c50a89bac))
* **engine:** never ask Copilot again for a review it already left ([#202](https://github.com/AntonioVentilii/officina/issues/202)) ([6bb178f](https://github.com/AntonioVentilii/officina/commit/6bb178f72335cec0240c38b2902ec682acfe3571))
* **github,db,api:** forward a bot comment's newest edit, not the last delivered ([#192](https://github.com/AntonioVentilii/officina/issues/192)) ([aa1cbe5](https://github.com/AntonioVentilii/officina/commit/aa1cbe57f35b36828634c96ef7391ba9bdda895e))
* **github:** give every GitHub call a deadline ([#172](https://github.com/AntonioVentilii/officina/issues/172)) ([356793f](https://github.com/AntonioVentilii/officina/commit/356793f4efe60e18e61fc36416aac31818ecbd6c))
* **runner,db,api:** fail a run whose session runs past its deadline ([#181](https://github.com/AntonioVentilii/officina/issues/181)) ([3e826b5](https://github.com/AntonioVentilii/officina/commit/3e826b53f3407d0737dab162208e4c9d26ec1c3f))


### Miscellaneous Chores

* **repo:** tighten the repository checks ([#186](https://github.com/AntonioVentilii/officina/issues/186)) ([ef57d0c](https://github.com/AntonioVentilii/officina/commit/ef57d0ca1cd7776ff2f7dbf9933606abfb1114f5))


### Code Refactoring

* **api,board:** read each value the board shows from the one place that owns it ([#179](https://github.com/AntonioVentilii/officina/issues/179)) ([f2802c1](https://github.com/AntonioVentilii/officina/commit/f2802c10789ca2c7e06adeccc716137d4e7b28d3))


### Tests

* **api,engine,github,runner:** type the test fakes as their ports instead of casting them ([#190](https://github.com/AntonioVentilii/officina/issues/190)) ([085745c](https://github.com/AntonioVentilii/officina/commit/085745c52463831f3c6c53323cf8ee4ab839424a))
* **api:** cover a collaborator's review and a deleted config in webhooks ([#175](https://github.com/AntonioVentilii/officina/issues/175)) ([5b7d8a6](https://github.com/AntonioVentilii/officina/commit/5b7d8a682680b86c308b6f107d631965aeb7438c))
* **api:** cover the approval plan view and realtime reconnect, wait on events ([#188](https://github.com/AntonioVentilii/officina/issues/188)) ([a76cc91](https://github.com/AntonioVentilii/officina/commit/a76cc913c8497fbb9d1a08c6197efa55c1b356c3))
* **api:** cover the connector's review and hand-in tools and its client checks ([#180](https://github.com/AntonioVentilii/officina/issues/180)) ([f09e4a6](https://github.com/AntonioVentilii/officina/commit/f09e4a6f2e0f7150878e8a504722e15cb164fe20))
* **core,engine:** build the largest chooser checklist from the contract's limits ([#184](https://github.com/AntonioVentilii/officina/issues/184)) ([02263cf](https://github.com/AntonioVentilii/officina/commit/02263cf2d47ff62bcb6601556363a5d2274b2d13))
* **core:** cover who a build is dispatched to and who may record a review ([#200](https://github.com/AntonioVentilii/officina/issues/200)) ([5155190](https://github.com/AntonioVentilii/officina/commit/51551901df2ffab8a3e271bd7d502ce689b81c76))
* **db,api:** age webhook deliveries from the named claim and retention windows ([#178](https://github.com/AntonioVentilii/officina/issues/178)) ([ed55e1c](https://github.com/AntonioVentilii/officina/commit/ed55e1c7fc76562ea2550a094cccff76aaa431c7))
* db` pass locally. New tests in `apps/api/test/connector.test.ts`. ([f09e4a6](https://github.com/AntonioVentilii/officina/commit/f09e4a6f2e0f7150878e8a504722e15cb164fe20))
* db` pass locally. New tests under "the SDK port". ([59b809e](https://github.com/AntonioVentilii/officina/commit/59b809eb63acf8119bbc28b610d1d500883c2be5))
* **db:** cover a migration that fails ([#189](https://github.com/AntonioVentilii/officina/issues/189)) ([b110872](https://github.com/AntonioVentilii/officina/commit/b110872f9bf8d2c76313c493104bd18faca6a701))
* **engine:** cover a learner run that fails or throws ([#183](https://github.com/AntonioVentilii/officina/issues/183)) ([6e5bb3e](https://github.com/AntonioVentilii/officina/commit/6e5bb3ec5c72da492817ebce11a950adf2ed4433))
* **github:** cover turning auto-merge off ([#173](https://github.com/AntonioVentilii/officina/issues/173)) ([b6609ec](https://github.com/AntonioVentilii/officina/commit/b6609ec7672229c655059b4566e7d57c6c4a4aad))
* **runner:** check what the SDK port sends for sessions, costs and environments ([#196](https://github.com/AntonioVentilii/officina/issues/196)) ([59b809e](https://github.com/AntonioVentilii/officina/commit/59b809eb63acf8119bbc28b610d1d500883c2be5))

## [1.7.3](https://github.com/AntonioVentilii/officina/compare/v1.7.2...v1.7.3) (2026-11-14)


### Bug Fixes

* **api,board:** return after sign-in only to a path that stays on this site (GHSA-fvrw-vmpg-vj88) ([02e0ef2](https://github.com/AntonioVentilii/officina/commit/02e0ef217a92b15ef34af673cca9968625a2d4af))
* **db,api:** ask a member to reconnect GitHub when its renewed tokens could not be stored ([#163](https://github.com/AntonioVentilii/officina/issues/163)) ([e4b36e2](https://github.com/AntonioVentilii/officina/commit/e4b36e2ab9416b20a254f99c2103bbd26061cafe))
* **db,api:** show an access event about one project only in that project's log (GHSA-hq84-4v24-5vrg) ([02e0ef2](https://github.com/AntonioVentilii/officina/commit/02e0ef217a92b15ef34af673cca9968625a2d4af))
* **db,engine:** settle a learning rewrite the project cannot run or whose run was lost twice ([#166](https://github.com/AntonioVentilii/officina/issues/166)) ([c9e11d7](https://github.com/AntonioVentilii/officina/commit/c9e11d789deb729ef47ad86bb6c389eaacbbfc6d))
* **engine,api:** let a learning's branch move during a build only by the commit Officina wrote (GHSA-2fw3-r47f-8fp6) ([02e0ef2](https://github.com/AntonioVentilii/officina/commit/02e0ef217a92b15ef34af673cca9968625a2d4af))
* **engine,db:** check a build's refs however its run ends, and after a restart (GHSA-6p5m-vr93-v439) ([02e0ef2](https://github.com/AntonioVentilii/officina/commit/02e0ef217a92b15ef34af673cca9968625a2d4af))
* **github:** read the token answer before parsing it, so an error page is a GitHub error ([#160](https://github.com/AntonioVentilii/officina/issues/160)) ([2e23e3b](https://github.com/AntonioVentilii/officina/commit/2e23e3b8f74e02f6270fe6452fac1c30e56aac9c))


### Documentation

* **ai:** say that github.ts writes a task's pull request link ([d883d18](https://github.com/AntonioVentilii/officina/commit/d883d182666ecd5779f6adf189bd6e33d5ab6fb4))
* **repo:** list the four advisories fixed in 1.7.3 ([02e0ef2](https://github.com/AntonioVentilii/officina/commit/02e0ef217a92b15ef34af673cca9968625a2d4af))
* **repo:** make the architecture and AGENTS.md match the code again ([#162](https://github.com/AntonioVentilii/officina/issues/162)) ([89629e5](https://github.com/AntonioVentilii/officina/commit/89629e504e933c6c639708750e8985aa56c7e29f))


### Code Refactoring

* **api:** read the link lifetimes in the cli help from people.ts ([#168](https://github.com/AntonioVentilii/officina/issues/168)) ([c97371b](https://github.com/AntonioVentilii/officina/commit/c97371bf70f203a8cf224edc3f5efe7ff7b2cfc9))
* **core,api:** read every input limit from one set in core ([#161](https://github.com/AntonioVentilii/officina/issues/161)) ([4c5a5b6](https://github.com/AntonioVentilii/officina/commit/4c5a5b6e0e44048701ece84bfcc90d8336bf49f6))
* **core,api:** write the approver roles and their floor rule once, in core ([#164](https://github.com/AntonioVentilii/officina/issues/164)) ([85f2557](https://github.com/AntonioVentilii/officina/commit/85f25574a5e7c57942dd2c9aa22448ad882566d4))
* **db,api:** keep the api's remaining sql in packages/db ([#169](https://github.com/AntonioVentilii/officina/issues/169)) ([811ec90](https://github.com/AntonioVentilii/officina/commit/811ec90109632b0669ad1ab6fec79f5febae3195))
* **db:** keep the run json and run recovery helpers in modules of their own ([02e0ef2](https://github.com/AntonioVentilii/officina/commit/02e0ef217a92b15ef34af673cca9968625a2d4af))
* **runner,engine,api:** find and read the role prompts in one place ([#165](https://github.com/AntonioVentilii/officina/issues/165)) ([4688630](https://github.com/AntonioVentilii/officina/commit/46886300e60deff0b8b57ed719d92ab3e69aab30))

## [1.7.2](https://github.com/AntonioVentilii/officina/compare/v1.7.1...v1.7.2) (2026-11-14)


### Documentation

* **repo:** the last four advisories are fixed in the released 1.7.1 ([#158](https://github.com/AntonioVentilii/officina/issues/158)) ([fbe5f32](https://github.com/AntonioVentilii/officina/commit/fbe5f32be869bde7ad09377c84fe4c234528d89c))

## [1.7.1](https://github.com/AntonioVentilii/officina/compare/v1.7.0...v1.7.1) (2026-11-14)


### Bug Fixes

* **api,db,board:** connector errors stay on the board and connected apps can be revoked (GHSA-gxmp-8mfp-rjc8) ([432e230](https://github.com/AntonioVentilii/officina/commit/432e230d853085bd1d57ce1e6f1c12fa3c6a8d24))
* **core,api,engine:** an ask for secrets, access or publishing made after the request holds the task for the owner (GHSA-xcr8-w6q4-285c) ([432e230](https://github.com/AntonioVentilii/officina/commit/432e230d853085bd1d57ce1e6f1c12fa3c6a8d24))
* **core,api:** members who may not read a confidential task neither read its build reason nor write on it (GHSA-mmm4-72xr-98x4) ([432e230](https://github.com/AntonioVentilii/officina/commit/432e230d853085bd1d57ce1e6f1c12fa3c6a8d24))
* **db,api:** record a connected app revoked on the board in the access log ([#156](https://github.com/AntonioVentilii/officina/issues/156)) ([2d95608](https://github.com/AntonioVentilii/officina/commit/2d9560839e1d16b1b8b9706d9c2933a91e76e2eb))
* **engine,github:** a build's write token ends with its run, and another branch moved with Officina's identity stops the build (GHSA-72wc-8h2c-x2qj) ([432e230](https://github.com/AntonioVentilii/officina/commit/432e230d853085bd1d57ce1e6f1c12fa3c6a8d24))


### Documentation

* **repo:** list the published security advisories and the version that fixes each ([432e230](https://github.com/AntonioVentilii/officina/commit/432e230d853085bd1d57ce1e6f1c12fa3c6a8d24))

## [1.7.0](https://github.com/AntonioVentilii/officina/compare/v1.6.1...v1.7.0) (2026-11-14)


### Features

* **api:** a developer hands in a build from the CLI ([#150](https://github.com/AntonioVentilii/officina/issues/150)) ([9a7aec5](https://github.com/AntonioVentilii/officina/commit/9a7aec5c5b4130725717fffcc74fb8b77b2f208c))
* **db,api,board:** an access log of sign-ins, invites, GitHub accounts and connected apps ([#146](https://github.com/AntonioVentilii/officina/issues/146)) ([562a686](https://github.com/AntonioVentilii/officina/commit/562a68621e0261eaa5490c26e96f9f40ae9ba64e))
* **engine,api:** a review bot's comment reaches the builder once it stops changing ([#147](https://github.com/AntonioVentilii/officina/issues/147)) ([1b726e4](https://github.com/AntonioVentilii/officina/commit/1b726e4732849d3d8caa5fbdda2dcf45bf9dc9cd))
* **engine,db,github:** an update from main that leaves the change as it was keeps the verification ([#151](https://github.com/AntonioVentilii/officina/issues/151)) ([a3a270e](https://github.com/AntonioVentilii/officina/commit/a3a270e5fb18c9fccaef22c002abc4ecfa2d2e52))


### Documentation

* **repo:** the GitHub App reads commit statuses and receives the status event ([#149](https://github.com/AntonioVentilii/officina/issues/149)) ([1bf33fe](https://github.com/AntonioVentilii/officina/commit/1bf33fec2e20db786e48d04d3c613d08ffe9f369))
* **repo:** the GitHub App's installations, its push events and how to reload a project's config ([#148](https://github.com/AntonioVentilii/officina/issues/148)) ([8fed854](https://github.com/AntonioVentilii/officina/commit/8fed854cff0af69da28c3e4e9a05c4f762e228c6))

## [1.6.1](https://github.com/AntonioVentilii/officina/compare/v1.6.0...v1.6.1) (2026-11-14)


### Bug Fixes

* **api:** picking an answer option pins the question the person saw ([#137](https://github.com/AntonioVentilii/officina/issues/137)) ([0293314](https://github.com/AntonioVentilii/officina/commit/02933147d21e83a877badec87eed1a931e91042c))
* **board:** relative times never point to the future ([#142](https://github.com/AntonioVentilii/officina/issues/142)) ([faca526](https://github.com/AntonioVentilii/officina/commit/faca52622fbe8c01fc9d919da98fa0f6cab93f69))
* **db,engine,api:** a build a member takes over stops the agent's run and its late result ([#141](https://github.com/AntonioVentilii/officina/issues/141)) ([3f0f792](https://github.com/AntonioVentilii/officina/commit/3f0f7921d4f06770141e9162e1aba7a051f5e1cf))
* **db,engine:** open a hand-in's pull request later when it fails to open ([#144](https://github.com/AntonioVentilii/officina/issues/144)) ([918d237](https://github.com/AntonioVentilii/officina/commit/918d237d515b401221b2a791788553ecde42c905))
* **github,engine,api:** catch up a pull request merged or closed whose webhook was missed ([#129](https://github.com/AntonioVentilii/officina/issues/129)) ([8a24c60](https://github.com/AntonioVentilii/officina/commit/8a24c600d67b9cd224b109973102f0d318f9979b))
* **github,engine:** approve a pull request once when the record of the approval is lost ([#136](https://github.com/AntonioVentilii/officina/issues/136)) ([1c450bf](https://github.com/AntonioVentilii/officina/commit/1c450bf74233b51e23552b9ec83f2d6e9b89f426))


### Documentation

* **repo:** the prompts and the architecture match the code ([#143](https://github.com/AntonioVentilii/officina/issues/143)) ([4b6a36a](https://github.com/AntonioVentilii/officina/commit/4b6a36a80225bde887046b9192394229eb495972))


### Code Refactoring

* **api,engine:** the webhook turns auto-merge off through the engine ([#138](https://github.com/AntonioVentilii/officina/issues/138)) ([82c4e91](https://github.com/AntonioVentilii/officina/commit/82c4e91f0b8fdc9b437a614de833b0c069347eca))
* **api:** the dev demo writes through the db functions ([#139](https://github.com/AntonioVentilii/officina/issues/139)) ([cced8e7](https://github.com/AntonioVentilii/officina/commit/cced8e73ea71ceffd86861cc40380676fbdc9884))
* **core,api:** who may answer a question, and who reads a confidential task, are each decided in one place ([#131](https://github.com/AntonioVentilii/officina/issues/131)) ([1e07a76](https://github.com/AntonioVentilii/officina/commit/1e07a76afeb0e110e163e13f41e040e95efcc535))
* **db:** write the same rows from one place ([#135](https://github.com/AntonioVentilii/officina/issues/135)) ([5d06627](https://github.com/AntonioVentilii/officina/commit/5d066276e81d865d9238f29b22ed90116fe68de0))
* **runner:** the session stream without a cast ([#140](https://github.com/AntonioVentilii/officina/issues/140)) ([47ef9d1](https://github.com/AntonioVentilii/officina/commit/47ef9d1df6863fb88b1690d55a0a4292e6a8769b))


### Tests

* **engine,runner:** cover the project's result checks and the empty checklist at verification ([#133](https://github.com/AntonioVentilii/officina/issues/133)) ([4dc0c31](https://github.com/AntonioVentilii/officina/commit/4dc0c31e25d300a790718681848fc12fc01800a6))

## [1.6.0](https://github.com/AntonioVentilii/officina/compare/v1.5.1...v1.6.0) (2026-11-14)


### Features

* **engine,api:** what the repository's own bots and CI do on a pull request reaches the task ([#125](https://github.com/AntonioVentilii/officina/issues/125)) ([4ba4cd7](https://github.com/AntonioVentilii/officina/commit/4ba4cd7b2d2103501ab115dc29d5ec10a7c30cb5))


### Bug Fixes

* **api,db:** open a request that skips the interview and submit it in one transaction ([#110](https://github.com/AntonioVentilii/officina/issues/110)) ([a01ba7a](https://github.com/AntonioVentilii/officina/commit/a01ba7a10f76f8d2b924b9266d2aa97fa3be35ff))
* **db:** a workspace name is unique ([#128](https://github.com/AntonioVentilii/officina/issues/128)) ([8b439e8](https://github.com/AntonioVentilii/officina/commit/8b439e8beed4e54ba070b9a5a7d4404ddf6cd20c))
* **engine:** the learner's briefs end like every brief ([#124](https://github.com/AntonioVentilii/officina/issues/124)) ([7784bc5](https://github.com/AntonioVentilii/officina/commit/7784bc584f63f7b01e5dc74984079913d03f7e83))


### Code Refactoring

* **db:** each query lives in the module that owns its table ([#132](https://github.com/AntonioVentilii/officina/issues/132)) ([ff6d395](https://github.com/AntonioVentilii/officina/commit/ff6d3959e17a81716e8c2ad16d44b7a33edb3299))


### Tests

* **api,github:** cover the user token refresh, the token request and review comment pages ([#130](https://github.com/AntonioVentilii/officina/issues/130)) ([f040211](https://github.com/AntonioVentilii/officina/commit/f0402115443c5c3f05b899d4ad30259c06bb09c9))
* **engine:** a result for a head or spec version replaced during the run is discarded ([#126](https://github.com/AntonioVentilii/officina/issues/126)) ([017b072](https://github.com/AntonioVentilii/officina/commit/017b072deee65a54579917bf64f6814d74032e29))


### Continuous Integration

* **repo:** pin the CI workflow's actions to commit SHAs ([#127](https://github.com/AntonioVentilii/officina/issues/127)) ([b756692](https://github.com/AntonioVentilii/officina/commit/b7566925e7a812200599558ad33a22d215bcc653))

## [1.5.1](https://github.com/AntonioVentilii/officina/compare/v1.5.0...v1.5.1) (2026-11-14)


### Bug Fixes

* **api:** a learning that replaces a whole line keeps the line break after it ([#121](https://github.com/AntonioVentilii/officina/issues/121)) ([f4e6924](https://github.com/AntonioVentilii/officina/commit/f4e692462f127e7bfae7c2bda586b2c166fa249e))


### Code Refactoring

* **core,db,api:** one list of approval gates and one approval state for the board and the CLI ([#111](https://github.com/AntonioVentilii/officina/issues/111)) ([2ea1876](https://github.com/AntonioVentilii/officina/commit/2ea18760c591d8cb714e3b27a7519d18c7f13d6f))


### Tests

* **db:** build the missing member id with a random uuid ([#123](https://github.com/AntonioVentilii/officina/issues/123)) ([09be0fd](https://github.com/AntonioVentilii/officina/commit/09be0fd3a8f3e2f0662b4016b7e161eb69fcb1c7))

## [1.5.0](https://github.com/AntonioVentilii/officina/compare/v1.4.0...v1.5.0) (2026-11-14)


### Features

* **db,engine,api,board:** an edit the default branch moved past goes back to the learner to be rewritten ([#119](https://github.com/AntonioVentilii/officina/issues/119)) ([e86c263](https://github.com/AntonioVentilii/officina/commit/e86c263f4f15e3d80e463e1db36bf94c557951ec))


### Bug Fixes

* **api,github:** close the pull request a failed accept left when its learning is rejected ([#106](https://github.com/AntonioVentilii/officina/issues/106)) ([85127e8](https://github.com/AntonioVentilii/officina/commit/85127e8c15f8ed63bfad14cd5c0d371dfd30dd0f))


### Build System

* board`. ([e86c263](https://github.com/AntonioVentilii/officina/commit/e86c263f4f15e3d80e463e1db36bf94c557951ec))

## [1.4.0](https://github.com/AntonioVentilii/officina/compare/v1.3.0...v1.4.0) (2026-11-13)


### Features

* **core,api,board:** make roles and permissions explicit in one matrix ([#114](https://github.com/AntonioVentilii/officina/issues/114)) ([ffe7224](https://github.com/AntonioVentilii/officina/commit/ffe7224722912d30b834a7b7962953616b78b576))
* **core,db,engine,api,board:** a security wall for secrets, access, publishing and confidential content ([#117](https://github.com/AntonioVentilii/officina/issues/117)) ([0971172](https://github.com/AntonioVentilii/officina/commit/097117273ec326901478f9e7ed75a07c8d3086fc))
* **core,engine,api,board:** agents hand work to the right person, from the owner to a developer who builds it ([#116](https://github.com/AntonioVentilii/officina/issues/116)) ([b7c6c19](https://github.com/AntonioVentilii/officina/commit/b7c6c1946f27c21d00436320f67e0403331fd0e5))
* **core,engine,api,board:** questions offer options with previews people choose from ([#115](https://github.com/AntonioVentilii/officina/issues/115)) ([9c532b8](https://github.com/AntonioVentilii/officina/commit/9c532b80d92d5867d73cef083161bedf4daaf2f4))


### Build System

* board`. ([9c532b8](https://github.com/AntonioVentilii/officina/commit/9c532b80d92d5867d73cef083161bedf4daaf2f4))

## [1.3.0](https://github.com/AntonioVentilii/officina/compare/v1.2.1...v1.3.0) (2026-11-13)


### Features

* **db,api,board:** show owners who accepted their invite and who is active ([#112](https://github.com/AntonioVentilii/officina/issues/112)) ([1029308](https://github.com/AntonioVentilii/officina/commit/1029308d469430669285ffd2bbdedf7b78932bf6))


### Bug Fixes

* **api:** land a learning's replacement text exactly as written ([#103](https://github.com/AntonioVentilii/officina/issues/103)) ([1023d00](https://github.com/AntonioVentilii/officina/commit/1023d002456bd2f554b1baefe9b98047440ff615))
* **engine,github:** take the spec status commit whose answer was lost as the task's head ([#108](https://github.com/AntonioVentilii/officina/issues/108)) ([d02ab16](https://github.com/AntonioVentilii/officina/commit/d02ab169c7bb591c45287c65a705ebc4377acf96))


### Documentation

* **repo:** match the README, AGENTS.md and architecture to the code ([#102](https://github.com/AntonioVentilii/officina/issues/102)) ([f463738](https://github.com/AntonioVentilii/officina/commit/f463738dc115e2aa6bb8331d293c4a5c4590a0f4))


### Code Refactoring

* **db:** read the auto-merge trail with one SQL rule shared by the board and the engine ([#105](https://github.com/AntonioVentilii/officina/issues/105)) ([2e69c52](https://github.com/AntonioVentilii/officina/commit/2e69c526b9ee5a510491fd8e0a69c35fc9c8db9c))


### Tests

* **api:** a member of one project cannot read, act on or decide a second real project's work ([#107](https://github.com/AntonioVentilii/officina/issues/107)) ([649ab31](https://github.com/AntonioVentilii/officina/commit/649ab3122deefb3ef6ba72cbceaa585a857dfa8a))
* **api:** every board route that changes something refuses a request without the request header ([#104](https://github.com/AntonioVentilii/officina/issues/104)) ([cf8da07](https://github.com/AntonioVentilii/officina/commit/cf8da07b57b8095578faa35539f829d6e1c27fac))
* **core:** who may decline, cancel, send back, release, pause and resume a task ([#109](https://github.com/AntonioVentilii/officina/issues/109)) ([eb78282](https://github.com/AntonioVentilii/officina/commit/eb78282bcd5a042fdcea01e09fd1401647b29194))

## [1.2.1](https://github.com/AntonioVentilii/officina/compare/v1.2.0...v1.2.1) (2026-11-13)


### Bug Fixes

* **api,db:** lock a learning from the first read to its decision ([#85](https://github.com/AntonioVentilii/officina/issues/85)) ([e6b59b9](https://github.com/AntonioVentilii/officina/commit/e6b59b9089ff3e19a6fad509a72e4c66466b0d84))
* **api,db:** purge webhook deliveries too old to be redelivered ([#69](https://github.com/AntonioVentilii/officina/issues/69)) ([33eee78](https://github.com/AntonioVentilii/officina/commit/33eee7836b0705cdaecf69bfc08806db9024b078))
* **api,db:** take a webhook delivery again when the process died handling it ([#60](https://github.com/AntonioVentilii/officina/issues/60)) ([e2ee473](https://github.com/AntonioVentilii/officina/commit/e2ee47396965e6f04bf51fb0f65aa2bf1f3be779))
* **api:** answer --help in the CLI, which scripts/officina sends with no arguments ([#101](https://github.com/AntonioVentilii/officina/issues/101)) ([796cf92](https://github.com/AntonioVentilii/officina/commit/796cf92be4f413c71e7a14a03c26f6faa96333e7))
* **api:** keep one customer's product out of the connector's tool descriptions ([#95](https://github.com/AntonioVentilii/officina/issues/95)) ([be3f3ab](https://github.com/AntonioVentilii/officina/commit/be3f3ab9a3a87c0cb38754434871b3fc24a6ef41))
* **api:** word the connector's role sentence as people read it ([#100](https://github.com/AntonioVentilii/officina/issues/100)) ([cb4e290](https://github.com/AntonioVentilii/officina/commit/cb4e290018530de5c3c73d7c2ddf5465c024b7ae))
* **board:** load the pre-paint script from a file the CSP allows ([#97](https://github.com/AntonioVentilii/officina/issues/97)) ([cff9bb9](https://github.com/AntonioVentilii/officina/commit/cff9bb9894a9b62b946a0f99444dec1a4568ee8d))
* **board:** point the guide at claude.ai's Customize &gt; Connectors and keep it off the consent page ([#99](https://github.com/AntonioVentilii/officina/issues/99)) ([762942d](https://github.com/AntonioVentilii/officina/commit/762942d810bfaa4d6e34581af5b2498840b4ebcb))
* **board:** recover from failed loads and a closed live stream ([#82](https://github.com/AntonioVentilii/officina/issues/82)) ([162d690](https://github.com/AntonioVentilii/officina/commit/162d6906a5601f4e14962f70eb9a8563c7860e62))
* **db,api:** make three writes that take several steps all or nothing ([#75](https://github.com/AntonioVentilii/officina/issues/75)) ([8a6c00d](https://github.com/AntonioVentilii/officina/commit/8a6c00da1d4e155559d3855297d12f6764bcd6aa))
* **db:** let two booting processes migrate at once ([#65](https://github.com/AntonioVentilii/officina/issues/65)) ([6a37675](https://github.com/AntonioVentilii/officina/commit/6a37675aee723fd69d060c4a3f10d84190710d4e))
* **db:** mark a merged learning applied whatever the case of its repository ([#68](https://github.com/AntonioVentilii/officina/issues/68)) ([64765e2](https://github.com/AntonioVentilii/officina/commit/64765e2613177e232e99bb673cdc8a0a024caaac))
* **db:** run the connector token rotation and the GitHub unlink in inTransaction ([#88](https://github.com/AntonioVentilii/officina/issues/88)) ([ca8c461](https://github.com/AntonioVentilii/officina/commit/ca8c46167e0ee3572946061ba043430c0b363782))
* **engine,api:** name the project in every link to a task ([#83](https://github.com/AntonioVentilii/officina/issues/83)) ([33900c0](https://github.com/AntonioVentilii/officina/commit/33900c0f8b6ddba9ac533667c6079849d79e732d))
* **engine:** finish each verified task on its own and record a refused token ([#79](https://github.com/AntonioVentilii/officina/issues/79)) ([7904253](https://github.com/AntonioVentilii/officina/commit/7904253a2f34d611286e60eb9706b6cd323d3225))
* **engine:** open a task's pull request again when opening it failed after the round ([#66](https://github.com/AntonioVentilii/officina/issues/66)) ([da3b8ab](https://github.com/AntonioVentilii/officina/commit/da3b8ab7e05a9cfb935291e2aca14e0060db8858))
* **engine:** record a checklist GitHub refuses instead of failing the chooser's run ([#80](https://github.com/AntonioVentilii/officina/issues/80)) ([a787fdd](https://github.com/AntonioVentilii/officina/commit/a787fdd83a837d8cf48e05d4a4947f09ab6129fc))
* **github:** let a failed learning acceptance be accepted again ([#59](https://github.com/AntonioVentilii/officina/issues/59)) ([b83f56a](https://github.com/AntonioVentilii/officina/commit/b83f56afb5566f9917e6e7400b445f2dab482c39))
* **github:** resolve the review threads on every page of a pull request ([#87](https://github.com/AntonioVentilii/officina/issues/87)) ([5f706b1](https://github.com/AntonioVentilii/officina/commit/5f706b158cf3015fdf8643fac335fcf8a3b15219))
* **runner,api:** save each synced agent as soon as it is written ([#84](https://github.com/AntonioVentilii/officina/issues/84)) ([70c8371](https://github.com/AntonioVentilii/officina/commit/70c83711bc561a39500558478d002eabc56d7315))
* **runner:** keep an accepted result whatever the agent submits after it ([#86](https://github.com/AntonioVentilii/officina/issues/86)) ([9a0bc71](https://github.com/AntonioVentilii/officina/commit/9a0bc7150d029c2eff5c59fa96373a4ccf0aae44))


### Dependencies

* **api:** drop the Anthropic SDK, which only the runner imports ([#64](https://github.com/AntonioVentilii/officina/issues/64)) ([422283c](https://github.com/AntonioVentilii/officina/commit/422283cf49d7f4a01b3108d6e679707dc5650aba))


### Documentation

* **ai:** point patterns at symbols instead of line numbers ([#67](https://github.com/AntonioVentilii/officina/issues/67)) ([b7eecdb](https://github.com/AntonioVentilii/officina/commit/b7eecdb13fbeeba2c01e4597793cbfbcf20414d0))
* **ai:** point the catalog and the workflows at where the code now lives ([#81](https://github.com/AntonioVentilii/officina/issues/81)) ([d10d8d4](https://github.com/AntonioVentilii/officina/commit/d10d8d418bce57956d2b3e575903806ee08a7b28))
* **repo:** list the tables the schema really has in the data model ([#63](https://github.com/AntonioVentilii/officina/issues/63)) ([71a264a](https://github.com/AntonioVentilii/officina/commit/71a264a3c887b3fa40bc93f0158cb693d0a2b4b7))


### Code Refactoring

* **api,db:** move the API's project and review lookups into packages/db ([#76](https://github.com/AntonioVentilii/officina/issues/76)) ([42ea76b](https://github.com/AntonioVentilii/officina/commit/42ea76b7ab6145fdd9e8dc3bfc1ace4663fd4946))
* **api,db:** read the requester's role and the new task through packages/db ([#78](https://github.com/AntonioVentilii/officina/issues/78)) ([aede336](https://github.com/AntonioVentilii/officina/commit/aede3365c633f8af65f3d3813eb1df3c395e5b06))
* **api:** decide who may open a request or comment in one place ([#91](https://github.com/AntonioVentilii/officina/issues/91)) ([2cdfb14](https://github.com/AntonioVentilii/officina/commit/2cdfb140a3aeafca74d02a912666d395b06eb38e))
* **board:** drop the unused isClosed helper ([#58](https://github.com/AntonioVentilii/officina/issues/58)) ([0714318](https://github.com/AntonioVentilii/officina/commit/0714318d0122be94f1cb84ba1cc437ef77053fb2))
* **board:** one isActive for runs and shared stage groups ([#92](https://github.com/AntonioVentilii/officina/issues/92)) ([d32f830](https://github.com/AntonioVentilii/officina/commit/d32f83089dc10b4d29f31d9d0bdaf45eaee7bfbb))
* **core:** read the contract's branch prefix, check depths and merge modes from their owners ([#93](https://github.com/AntonioVentilii/officina/issues/93)) ([89cf4e6](https://github.com/AntonioVentilii/officina/commit/89cf4e6e3752babef1eef0aba9945bb335300219))
* **db,api:** share inTransaction and register projects with it ([#72](https://github.com/AntonioVentilii/officina/issues/72)) ([f04dcb4](https://github.com/AntonioVentilii/officina/commit/f04dcb461d8c1413bdc8afa82d6e2677bcad2b61))
* **db,core:** read the values packages/db respelled from where they live ([#89](https://github.com/AntonioVentilii/officina/issues/89)) ([6db83df](https://github.com/AntonioVentilii/officina/commit/6db83df2c067e1fccc1536c83774c963c3e5f394))
* **engine,api:** one owner for the engine actor and the runner name ([#56](https://github.com/AntonioVentilii/officina/issues/56)) ([c7ee77f](https://github.com/AntonioVentilii/officina/commit/c7ee77f2bb0584c69ed8172684e1f8e27b7ff40f))
* **engine,core,api:** drop the exports and the branch nothing reaches ([#90](https://github.com/AntonioVentilii/officina/issues/90)) ([a59a088](https://github.com/AntonioVentilii/officina/commit/a59a0880a065f8d4816bf116fffb88a0c8695bcb))
* **engine,db:** move the GitHub mirroring queries into packages/db ([#73](https://github.com/AntonioVentilii/officina/issues/73)) ([75073c3](https://github.com/AntonioVentilii/officina/commit/75073c38aca835e9dc1f9e9458121c1c89ee14e5))
* **engine,db:** move the interviewer and learner queries into packages/db ([#57](https://github.com/AntonioVentilii/officina/issues/57)) ([8dc231a](https://github.com/AntonioVentilii/officina/commit/8dc231ab15e0219f82b2c69ffbda8de10d51812c))
* **engine:** move the result checks out of step.ts ([#74](https://github.com/AntonioVentilii/officina/issues/74)) ([6b4ca09](https://github.com/AntonioVentilii/officina/commit/6b4ca09f8cdf1c939fc5f854fb7881934bd31408))
* **engine:** move the session and apply phases out of step.ts ([#77](https://github.com/AntonioVentilii/officina/issues/77)) ([16912f1](https://github.com/AntonioVentilii/officina/commit/16912f19a610520c1d1f6959d22277c8df6144d7))
* **engine:** split runAgentStep into named phases ([#71](https://github.com/AntonioVentilii/officina/issues/71)) ([fe2e1be](https://github.com/AntonioVentilii/officina/commit/fe2e1be6b5269b97d207a3de7adbf6d628d357b9))
* **github:** one merge-when-ready flow for the App and for a person ([#94](https://github.com/AntonioVentilii/officina/issues/94)) ([0dd9d29](https://github.com/AntonioVentilii/officina/commit/0dd9d29afbe68f2bd665d3d270d515afc905cb39))
* **github:** one request helper for the App and for a person ([#70](https://github.com/AntonioVentilii/officina/issues/70)) ([652d465](https://github.com/AntonioVentilii/officina/commit/652d46505ab6b83ba73ae03deb68a8dd8f3c9f42))


### Tests

* **api:** the board stream sends a member only their own projects' events ([#98](https://github.com/AntonioVentilii/officina/issues/98)) ([9e3353e](https://github.com/AntonioVentilii/officina/commit/9e3353e03927f548924981e6b5bf51910a17912e))
* db` (112 pass), `bun run check:board`: all green. ([c7ee77f](https://github.com/AntonioVentilii/officina/commit/c7ee77f2bb0584c69ed8172684e1f8e27b7ff40f))
* db` (118 pass): all green. ([b83f56a](https://github.com/AntonioVentilii/officina/commit/b83f56afb5566f9917e6e7400b445f2dab482c39))
* db` (119 pass, with main merged): all green. ([e2ee473](https://github.com/AntonioVentilii/officina/commit/e2ee47396965e6f04bf51fb0f65aa2bf1f3be779))
* db` all pass locally. ([aede336](https://github.com/AntonioVentilii/officina/commit/aede3365c633f8af65f3d3813eb1df3c395e5b06))
* db` pass locally. ([89cf4e6](https://github.com/AntonioVentilii/officina/commit/89cf4e6e3752babef1eef0aba9945bb335300219))
* db` pass locally. ([2cdfb14](https://github.com/AntonioVentilii/officina/commit/2cdfb140a3aeafca74d02a912666d395b06eb38e))
* db` pass locally. ([6db83df](https://github.com/AntonioVentilii/officina/commit/6db83df2c067e1fccc1536c83774c963c3e5f394))
* db` pass locally. ([5f706b1](https://github.com/AntonioVentilii/officina/commit/5f706b158cf3015fdf8643fac335fcf8a3b15219))
* db` pass locally. ([70c8371](https://github.com/AntonioVentilii/officina/commit/70c83711bc561a39500558478d002eabc56d7315))
* db` pass locally. ([33900c0](https://github.com/AntonioVentilii/officina/commit/33900c0f8b6ddba9ac533667c6079849d79e732d))
* db` pass locally. ([ca8c461](https://github.com/AntonioVentilii/officina/commit/ca8c46167e0ee3572946061ba043430c0b363782))
* db` pass locally. ([e6b59b9](https://github.com/AntonioVentilii/officina/commit/e6b59b9089ff3e19a6fad509a72e4c66466b0d84))
* db` pass locally. ([a787fdd](https://github.com/AntonioVentilii/officina/commit/a787fdd83a837d8cf48e05d4a4947f09ab6129fc))
* db` pass locally. ([7904253](https://github.com/AntonioVentilii/officina/commit/7904253a2f34d611286e60eb9706b6cd323d3225))


### Build System

* **repo:** add ESLint, knip and jscpd to the quality gate ([#62](https://github.com/AntonioVentilii/officina/issues/62)) ([20e8c49](https://github.com/AntonioVentilii/officina/commit/20e8c496717d9b6c0e27a071d2ce8b34f1e1523e))


### Continuous Integration

* **repo:** set the Bun version and the database suites once, and check rule 14 ([#96](https://github.com/AntonioVentilii/officina/issues/96)) ([be4ea1a](https://github.com/AntonioVentilii/officina/commit/be4ea1abd01b2a85cadc280061f4f87e4e2d8e6a))

## [1.2.0](https://github.com/AntonioVentilii/officina/compare/v1.1.1...v1.2.0) (2026-11-12)


### Features

* **api:** add the Officina connector for Claude, with its own OAuth server ([#43](https://github.com/AntonioVentilii/officina/issues/43)) ([db4e87b](https://github.com/AntonioVentilii/officina/commit/db4e87b0cdf28f537fda0deaed91083bf75e9907))
* **board:** welcome guide on first sign-in, with examples and the Claude connector ([#45](https://github.com/AntonioVentilii/officina/issues/45)) ([3fecd14](https://github.com/AntonioVentilii/officina/commit/3fecd145bfb396a524861328a672e4d5ae9ec02b))
* **core:** require each project's agent docs pages and catalogs in its config ([#37](https://github.com/AntonioVentilii/officina/issues/37)) ([fb2eaf2](https://github.com/AntonioVentilii/officina/commit/fb2eaf2043f404337383b855b0e71530f3f9453b))
* **engine:** ask Copilot to review new pull requests as the requester ([#55](https://github.com/AntonioVentilii/officina/issues/55)) ([ae03366](https://github.com/AntonioVentilii/officina/commit/ae03366d2c885326484a1dd9d2d7342ed4c7305f))
* **engine:** auto-merge as a project setting the chooser decides per result ([#47](https://github.com/AntonioVentilii/officina/issues/47)) ([9d7646b](https://github.com/AntonioVentilii/officina/commit/9d7646bfd74d6e92741174378290bd808f4b3c3c))
* **engine:** let the learner edit a project's agent docs as a target of their own ([#40](https://github.com/AntonioVentilii/officina/issues/40)) ([1315cca](https://github.com/AntonioVentilii/officina/commit/1315cca0e97cb37c9a1b74b9238e4f9408d4b5f1))
* **engine:** never merge or turn on auto-merge; a person always merges ([#42](https://github.com/AntonioVentilii/officina/issues/42)) ([af9b9d5](https://github.com/AntonioVentilii/officina/commit/af9b9d5e21b8c46749f76e95691b8d080370ebdc))
* **engine:** onboard every project's agent docs before anything else is built ([#38](https://github.com/AntonioVentilii/officina/issues/38)) ([25016fc](https://github.com/AntonioVentilii/officina/commit/25016fca911ed939641089df1185a1ab6e76e20b))
* **engine:** read Copilot reviews that leave nothing on the code ([#49](https://github.com/AntonioVentilii/officina/issues/49)) ([766b885](https://github.com/AntonioVentilii/officina/commit/766b885703c064441b65e317bbf5609a56f45cff))
* **engine:** send back new files their catalog page does not list ([#39](https://github.com/AntonioVentilii/officina/issues/39)) ([3c66e17](https://github.com/AntonioVentilii/officina/commit/3c66e1774399562b4175a193af3ac9b7fc79c15b))
* **runner:** give every role the code standard after its own prompt ([#36](https://github.com/AntonioVentilii/officina/issues/36)) ([9173daf](https://github.com/AntonioVentilii/officina/commit/9173daffcaa6596616ea4321c99bb47f62f88b65))


### Documentation

* **ai:** add Officina's own agent docs ([#41](https://github.com/AntonioVentilii/officina/issues/41)) ([500269a](https://github.com/AntonioVentilii/officina/commit/500269a80ffee4bb9565cc936de5f80438abf94b))
* **ai:** have every pr-and-ci page link the scope rules ([#54](https://github.com/AntonioVentilii/officina/issues/54)) ([7f6c637](https://github.com/AntonioVentilii/officina/commit/7f6c6377d679b72b972c84979fab7b916a79581a))
* **repo:** restore architecture text the catalog check merge dropped ([#48](https://github.com/AntonioVentilii/officina/issues/48)) ([90e60fc](https://github.com/AntonioVentilii/officina/commit/90e60fc5f2ff2b32d4d7e2ca18420e02e7d0a7d0))
* **standards:** add the universal code standard every repository links ([#35](https://github.com/AntonioVentilii/officina/issues/35)) ([8cc13b1](https://github.com/AntonioVentilii/officina/commit/8cc13b11a35a81e05e7d61e7187044082167dac4))
* **standards:** ban the em dash and the en dash used as a break, keep en dash ranges ([#50](https://github.com/AntonioVentilii/officina/issues/50)) ([9842031](https://github.com/AntonioVentilii/officina/commit/98420315d441a90a05ac17a572d55427b181d529))


### Code Refactoring

* **api:** name agent roles in one place for the board and the Agents page ([#53](https://github.com/AntonioVentilii/officina/issues/53)) ([f220191](https://github.com/AntonioVentilii/officina/commit/f2201916b801d34da4f0949e3476ccaf9e98cffb))
* **board:** keep the anvil in one file ([#44](https://github.com/AntonioVentilii/officina/issues/44)) ([98ae63a](https://github.com/AntonioVentilii/officina/commit/98ae63a99980991997c089cd33f5d1c4d8c54b7f))
* **core:** read lane paths from the normalized project config ([#52](https://github.com/AntonioVentilii/officina/issues/52)) ([ad2503a](https://github.com/AntonioVentilii/officina/commit/ad2503adfd256042e565fae4a6f71aed4a833cf0))
* **engine:** one fence helper for every brief ([#51](https://github.com/AntonioVentilii/officina/issues/51)) ([faf2e7b](https://github.com/AntonioVentilii/officina/commit/faf2e7ba7fa730f021b98295653d9871bc48e332))

## [1.1.1](https://github.com/AntonioVentilii/officina/compare/v1.1.0...v1.1.1) (2026-11-04)


### Continuous Integration

* **workflows:** pass client-id to create-github-app-token ([#32](https://github.com/AntonioVentilii/officina/issues/32)) ([650ec2d](https://github.com/AntonioVentilii/officina/commit/650ec2d5ee5c48fab81a7aaa9bc1cf33457a76e6))

## [1.1.0](https://github.com/AntonioVentilii/officina/compare/v1.0.1...v1.1.0) (2026-11-03)


### Features

* **board:** reveal the new look in a circle from the switch ([#30](https://github.com/AntonioVentilii/officina/issues/30)) ([4ade8bc](https://github.com/AntonioVentilii/officina/commit/4ade8bceaad6a8fb891ef8f977027bf4a48218e7))

## [1.0.1](https://github.com/AntonioVentilii/officina/compare/v1.0.0...v1.0.1) (2026-11-03)


### Bug Fixes

* **api:** keep the realtime connection alive ([#28](https://github.com/AntonioVentilii/officina/issues/28)) ([2cf5412](https://github.com/AntonioVentilii/officina/commit/2cf5412b06486e49b75dc09392f4585f9063ee28))

## 1.0.0 (2026-11-03)


### Features

* **api,engine:** in-process scheduler, project setup CLI and config refresh on push ([#5](https://github.com/AntonioVentilii/officina/issues/5)) ([5d668c6](https://github.com/AntonioVentilii/officina/commit/5d668c6625ad5c5813b9693af4528362b04753cc))
* **api:** board API with sign-in links, sessions and realtime events ([#11](https://github.com/AntonioVentilii/officina/issues/11)) ([db39541](https://github.com/AntonioVentilii/officina/commit/db395410bf2240c542fa2f0db845d9865c813609))
* **api:** connect GitHub, sign in with it, and approve and merge as the verifier ([#16](https://github.com/AntonioVentilii/officina/issues/16)) ([18ccd70](https://github.com/AntonioVentilii/officina/commit/18ccd706cf6bc8f0c132b1faf5e2057c54fd5ff8))
* **api:** task commands, a local wrapper and the task runbook ([#8](https://github.com/AntonioVentilii/officina/issues/8)) ([05891ac](https://github.com/AntonioVentilii/officina/commit/05891ac560e98bb1d08a43bb9e2168e92c699132))
* **board:** kanban board with live agent logs, task page, inbox and agents ([#12](https://github.com/AntonioVentilii/officina/issues/12)) ([c80723c](https://github.com/AntonioVentilii/officina/commit/c80723c06fe1b01ff6e4cfe1063b6a9788957eb8))
* **board:** two selectable looks, Modernista and Tecnica ([#22](https://github.com/AntonioVentilii/officina/issues/22)) ([3291598](https://github.com/AntonioVentilii/officina/commit/32915981e98454530cfaa8bbd4747057c2d34039))
* **core,db:** agent output contracts and transactional task store ([#2](https://github.com/AntonioVentilii/officina/issues/2)) ([0af6055](https://github.com/AntonioVentilii/officina/commit/0af60550f7b809f5a94be5483f5210a37785b88a))
* **core,db:** task lifecycle, lanes, approval policies and initial schema ([#1](https://github.com/AntonioVentilii/officina/issues/1)) ([26ce822](https://github.com/AntonioVentilii/officina/commit/26ce822cfca7ca19c4b94b49fe5368852843c8c1))
* **engine:** approval chooser plans who approves each gate and how closely ([#13](https://github.com/AntonioVentilii/officina/issues/13)) ([05230e1](https://github.com/AntonioVentilii/officina/commit/05230e10ac64909bd6d2df42db71a1190625313f))
* **engine:** interviewer agent sharpens requests before triage ([#15](https://github.com/AntonioVentilii/officina/issues/15)) ([53117c4](https://github.com/AntonioVentilii/officina/commit/53117c42043b3aeeb8f616b0a0c219916da14208))
* **engine:** learner agent proposes checked edits after each merged task ([#14](https://github.com/AntonioVentilii/officina/issues/14)) ([b5cf3b4](https://github.com/AntonioVentilii/officina/commit/b5cf3b4be17b7f7fed9870d1c9f74de8da6426d7))
* **engine:** low-risk results merge unchecked, GitHub reviews reach the builder, and a simpler board ([#18](https://github.com/AntonioVentilii/officina/issues/18)) ([5525f57](https://github.com/AntonioVentilii/officina/commit/5525f571a64034acb809d8d4983a2926a2ff3bc2))
* **github,api:** GitHub App client, signed webhooks and API server ([#3](https://github.com/AntonioVentilii/officina/issues/3)) ([a058ffd](https://github.com/AntonioVentilii/officina/commit/a058ffd040b19ff8cdbc9c830b7bf6236a77056b))
* **runner,api:** authenticate to Anthropic by workload identity federation ([#6](https://github.com/AntonioVentilii/officina/issues/6)) ([d645d84](https://github.com/AntonioVentilii/officina/commit/d645d842cdc2b847874fad0e2162fad3db6b2431))
* **runner,engine:** run agent roles on Managed Agents and apply their results ([#4](https://github.com/AntonioVentilii/officina/issues/4)) ([041d07c](https://github.com/AntonioVentilii/officina/commit/041d07cc0aece5a6e5dcd76fad5fde0d0ac35f7a))
* **runner:** agents run the newest Opus, resolved at boot ([#17](https://github.com/AntonioVentilii/officina/issues/17)) ([f45048d](https://github.com/AntonioVentilii/officina/commit/f45048d519c93aa2bce6d7702d9fdc4402ea5c5e))


### Bug Fixes

* **engine,api:** close the remaining audit findings ([#25](https://github.com/AntonioVentilii/officina/issues/25)) ([acc5a97](https://github.com/AntonioVentilii/officina/commit/acc5a97d097c7b511854a9dfdef95bfbb34d1152))
* **engine,deploy:** let the app user mint Fly identity tokens and block tasks on unexpected step failures ([#9](https://github.com/AntonioVentilii/officina/issues/9)) ([1843c1c](https://github.com/AntonioVentilii/officina/commit/1843c1c5cfbd5969c602f089ac6497df8aefa1d1))
* **engine:** pull request title, task link, spec status and checklist on the pull request ([#10](https://github.com/AntonioVentilii/officina/issues/10)) ([4853a52](https://github.com/AntonioVentilii/officina/commit/4853a52ae712799da2a456519893b14287576e21))


### Documentation

* initial architecture, README, agent entry point and MIT license ([d12fdd4](https://github.com/AntonioVentilii/officina/commit/d12fdd4f62bef1bfc19198df7a091333e2fdfc21))
* record the deployed state of the Vici instance ([#7](https://github.com/AntonioVentilii/officina/issues/7)) ([8266d72](https://github.com/AntonioVentilii/officina/commit/8266d723d8d3f8709d487b8ff2345753c3f3c090))
* record Vici instance infrastructure and required secrets ([7448e3b](https://github.com/AntonioVentilii/officina/commit/7448e3b813b2d6cd1352d85003a5e9c7111bf1ca))


### Miscellaneous Chores

* **repo:** prepare to go public with a README, a security policy and stranger reviews ignored ([#21](https://github.com/AntonioVentilii/officina/issues/21)) ([33a73d8](https://github.com/AntonioVentilii/officina/commit/33a73d84b40b29b23750bcde4a2d1b131c0ba625))


### Continuous Integration

* **checks:** add checks-pass gate for the main ruleset ([#19](https://github.com/AntonioVentilii/officina/issues/19)) ([c91a474](https://github.com/AntonioVentilii/officina/commit/c91a47444ac0d4792b4d14bd0745f147168f1235))
* **checks:** gate checks-pass with the shared needs_success action ([#23](https://github.com/AntonioVentilii/officina/issues/23)) ([77ba52c](https://github.com/AntonioVentilii/officina/commit/77ba52c30a3958454c17259ef6fa9b11c7b40271))
* **checks:** require a scoped Conventional Commit PR title ([#20](https://github.com/AntonioVentilii/officina/issues/20)) ([8fa19b9](https://github.com/AntonioVentilii/officina/commit/8fa19b930a0a158280808154579ed43e70892a53))
* **release:** leave the release-please manifest out of Prettier ([#27](https://github.com/AntonioVentilii/officina/issues/27)) ([560efd2](https://github.com/AntonioVentilii/officina/commit/560efd21f7b1e7100f7428cdffad7f6e2c8c22b1))
* **release:** release-please cuts versions and a v* tag deploys to Fly ([#24](https://github.com/AntonioVentilii/officina/issues/24)) ([9dd8d1d](https://github.com/AntonioVentilii/officina/commit/9dd8d1d750e8261041f35cee07d5ca8d55cc4272))
