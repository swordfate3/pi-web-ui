Feature: Mobile connection recovery
  Scenario: Returning online restores the same Pi without losing a draft or replaying a prompt
    Given an isolated real Pi session is open in a mobile browser
    When the mobile browser loses network for more than fifteen seconds
    Then returning online restores the same conversation and unsent draft
