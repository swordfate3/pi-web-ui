@history-pagination
Feature: Read complete results and return through conversation pages
  Scenario Outline: Read older answers without new replies moving the page
    Given an isolated paginated conversation is running at "<viewport>" size
    When I browse older answers and return one page at a time
    Then long results can be read as Markdown pages in both directions
    And incoming replies leave the historical page and scroll position unchanged
    When I explicitly return to the newest replies
    Then the newest generated answer is visible and pagination fits the viewport

    Examples:
      | viewport |
      | desktop  |
      | mobile   |
