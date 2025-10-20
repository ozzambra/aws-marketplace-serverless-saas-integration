const redirectToProductPage = process.env.VARIABLE_NAME || 'false';

exports.redirecthandler = async(event, context, callback) => {
  console.log("event:", event);
  const redirectUrl = "/?" + event['body'];
  console.log("redirectUrl:", redirectUrl);

  const response = {
      statusCode: 302,
      headers: {
          Location: redirectUrl
      },
  };
  
  return response;

};
