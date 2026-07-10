// Calcula métricas derivadas de um post

function calcEngagement(post) {
  const interactions = (post.like_count || 0) + (post.comments_count || 0) +
    (post.insights?.saved || 0) + (post.insights?.shares || 0);
  const reach = post.insights?.reach || 0;
  const engagementRate = reach > 0 ? ((interactions / reach) * 100).toFixed(2) : null;
  return { interactions, engagementRate };
}

// Compara engajamento de um post com a média dos últimos N posts do mesmo perfil
function compareWithPrevious(currentPost, previousPosts, n = 5) {
  const recent = previousPosts
    .filter(p => p.account_label === currentPost.account_label && p.id !== currentPost.id)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, n);

  if (recent.length === 0) return null;

  const avgInteractions = recent.reduce((sum, p) => {
    const { interactions } = calcEngagement(p);
    return sum + interactions;
  }, 0) / recent.length;

  const { interactions: currentInteractions } = calcEngagement(currentPost);
  if (avgInteractions === 0) return null;

  return (((currentInteractions - avgInteractions) / avgInteractions) * 100).toFixed(1);
}

// Normaliza tipo de mídia para exibição
function normalizeMediaType(type) {
  const map = {
    IMAGE: 'Foto',
    VIDEO: 'Vídeo',
    CAROUSEL_ALBUM: 'Carrossel',
    REELS: 'Reels',
  };
  return map[type] || type;
}

module.exports = { calcEngagement, compareWithPrevious, normalizeMediaType };
