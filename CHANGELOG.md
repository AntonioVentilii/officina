# Changelog

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
