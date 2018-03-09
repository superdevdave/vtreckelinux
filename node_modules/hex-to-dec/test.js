var expect = require("chai").expect;
var hexToDec = require("./index");

describe("hexToDec", function () {

  it("should be 65535 when FFFF is passed", function () {
    expect(hexToDec("FFFF")).to.equal(65535);
  });

});
