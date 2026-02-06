import { hello } from "./test";

test("hello returns correct string", () => {
  expect(hello()).toBe("Hello PR!");
});
