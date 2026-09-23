// Small numeric helpers used by the order pipeline.

function add(a, b) {
  return a + b;
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function average(nums) {
  if (nums.length === 0) return 0;
  const sum = nums.reduce((a, b) => a + b, 0);
  return sum / nums.length;
}

module.exports = { add, clamp, average };
