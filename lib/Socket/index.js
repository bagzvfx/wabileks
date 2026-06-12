import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js';
import { makeCommunitiesSocket } from './communities.js';
import { socket as decorateSocket } from '../Utils/helper.js';

// export the last socket layer
const makeWASocket = (config) => {
    const newConfig = {
        ...DEFAULT_CONNECTION_CONFIG,
        ...config
    };
    const sock = makeCommunitiesSocket(newConfig);
    decorateSocket(sock);
    return sock;
};
export default makeWASocket;
//# sourceMappingURL=index.js.map