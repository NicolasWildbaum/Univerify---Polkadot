const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

module.exports = buildModule("Counter", (m) => {
  const counter = m.contract("Counter");
  return { counter };
});
