Feature: Portable remote access onboarding
  Scenario Outline: Generate remote connection and recovery materials without storing passwords
    When I open remote onboarding on a real Pi in "<screen>" with "<locale>"
    Then onboarding can be skipped and reopened from settings
    When I generate a new single-session deployment for pi.example.com
    Then deployment materials are pending and login management never requests a password
    Examples:
      | screen  | locale |
      | desktop | en     |
      | mobile  | zh-CN  |
