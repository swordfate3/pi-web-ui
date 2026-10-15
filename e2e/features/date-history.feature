@date-history
Feature: Date-selected bounded conversation history
  Large saved conversations must not download their complete history on connect.
  Choosing a date changes browser history only, not the underlying Pi session.

  Scenario Outline: Choose historical dates without losing the current session
    Given a large dated history conversation is running at "<viewport>" size
    When I open the dated history web page
    Then I see the recent history marker but not the old date marker
    When I choose the old history date
    Then I see only the selected old date history
    When I return to the recent three days
    Then I see the recent history marker but not the old date marker
    And the history date controls fit in the viewport
    And saved-session dates load old sessions only after date selection

    Examples:
      | viewport |
      | desktop  |
      | mobile   |
