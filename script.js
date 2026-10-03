const ideas = [
  'What if you invented an animal no one has ever seen?',
  'What if your next drawing used only three colors?',
  'What if you built a tiny town out of cardboard boxes?',
  'What if you made up a secret handshake together?',
  'What if you designed a spaceship powered by giggles?',
  'What if you turned your favorite story into a puppet show?',
  'What if you drew a map of an imaginary island?',
  'What if you made a thank-you card for someone kind?',
  'What if you invented a new game with just paper and a pencil?',
  'What if you found five different shapes hiding in your room?'
];
let currentIdea = 0;
document.getElementById('shuffle').addEventListener('click', () => {
  currentIdea = (currentIdea + 1 + Math.floor(Math.random() * (ideas.length - 1))) % ideas.length;
  document.getElementById('idea').textContent = ideas[currentIdea];
});
