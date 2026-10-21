@native-terminal
Feature: Installed trusted native Pi terminal through the real Hub and Gate
  Scenario: One installed native child handles explicit remote input and local handoff
    Given an isolated installed native Pi with the approved live admin preflight
    Then its ordinary Hub chat is read-only from startup
    When I pair the separate terminal and explicitly yield local input
    Then native confirmation rejection has zero effects and acceptance has exactly one
    And Chinese composition and manual native panel resize use the same child
    Then local reclaim fences remote input and a new explicit handoff works
    And native exit leaves no active child helper socket or owned Docker resource
