# Changelog

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
